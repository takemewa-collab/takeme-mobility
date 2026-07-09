import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { verifyInternalRequest } from '@/lib/auth/internal-auth';
import { checkModeEscalation } from '@/lib/security/reactionEngine';
import { SESClient, ListIdentitiesCommand } from '@aws-sdk/client-ses';
import { SNSClient, GetSMSAttributesCommand } from '@aws-sdk/client-sns';

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/monitor
//
// Master health check — tests every critical service, logs to DB,
// triggers alerts on failure, includes RCA engine.
// Runs every minute via Vercel Cron.
// ═══════════════════════════════════════════════════════════════════════════

const APP_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://takememobility.com';

interface CheckResult {
  service: string;
  status: 'ok' | 'warn' | 'error';
  latency_ms: number;
  error?: string;
}

// RCA type is now Hypothesis[] — see analyzeRCA below

async function timed(service: string, fn: () => Promise<void>): Promise<CheckResult> {
  const start = Date.now();
  try {
    await fn();
    return { service, status: 'ok', latency_ms: Date.now() - start };
  } catch (e: unknown) {
    return { service, status: 'error', latency_ms: Date.now() - start, error: (e as Error).message };
  }
}

function getAWSCredentials() {
  return {
    region: process.env.AWS_REGION ?? 'us-east-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  };
}

// ── Checks ───────────────────────────────────────────────────────────────

function checkPage(service: string, path: string) {
  return timed(service, async () => {
    const res = await fetch(`${APP_URL}${path}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  });
}

function checkHealthAPI() {
  return timed('api_health', async () => {
    const res = await fetch(`${APP_URL}/api/health`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (body.status !== 'ok') throw new Error(`status: ${body.status}`);
  });
}

function checkSupabaseDB() {
  return timed('supabase_db', async () => {
    const sb = createServiceClient();
    const { error } = await sb.from('profiles').select('id').limit(1);
    if (error) throw new Error(error.message);
  });
}

function checkSupabaseAuth() {
  return timed('supabase_auth', async () => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (!url) throw new Error('SUPABASE_URL not set');
    const res = await fetch(`${url}/auth/v1/settings`, {
      headers: { 'apikey': process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  });
}

function checkStripeAPI() {
  return timed('stripe_api', async () => {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY not set');
    const res = await fetch('https://api.stripe.com/v1/payment_intents?limit=1', {
      headers: { 'Authorization': `Bearer ${key}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  });
}

function checkStripeWebhook() {
  return timed('stripe_webhook', async () => {
    if (!process.env.STRIPE_WEBHOOK_SECRET) throw new Error('STRIPE_WEBHOOK_SECRET not set');
    const res = await fetch(`${APP_URL}/api/stripe/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (res.status === 404 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
  });
}

function checkSES() {
  return timed('aws_ses', async () => {
    if (!process.env.AWS_ACCESS_KEY_ID) throw new Error('AWS credentials not set');
    const ses = new SESClient(getAWSCredentials());
    await ses.send(new ListIdentitiesCommand({ MaxItems: 1 }));
  });
}

function checkSNS() {
  return timed('aws_sns', async () => {
    // SMS OTP now handled by Supabase + Twilio Verify, not AWS SNS
    // Check that Supabase is reachable (phone auth depends on it)
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (!url) throw new Error('Supabase URL not set');
    const res = await fetch(`${url}/auth/v1/health`, {
      headers: { 'apikey': process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '' },
    });
    if (!res.ok) throw new Error(`Supabase auth health: HTTP ${res.status}`);
  });
}

function checkRedis() {
  return timed('upstash_redis', async () => {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) throw new Error('Redis credentials not set');
    const res = await fetch(`${url}/ping`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (body.result !== 'PONG') throw new Error(`Unexpected: ${JSON.stringify(body)}`);
  });
}

function checkAbly() {
  return timed('ably', async () => {
    const key = process.env.ABLY_KEY;
    if (!key) throw new Error('ABLY_KEY not set');
    const res = await fetch('https://rest.ably.io/time', {
      headers: { 'Authorization': `Basic ${Buffer.from(key).toString('base64')}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  });
}

function checkQStash() {
  return timed('qstash', async () => {
    const token = process.env.US_EAST_1_QSTASH_TOKEN ?? process.env.QSTASH_TOKEN;
    if (!token) throw new Error('QStash token not set');
    const baseUrl = process.env.US_EAST_1_QSTASH_URL ?? 'https://qstash.upstash.io';
    const res = await fetch(`${baseUrl}/v2/messages`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
  });
}

// ── RCA Engine — Alternative Hypotheses ──────────────────────────────────

interface Hypothesis {
  cause: string;
  confidence: number;
  autofixAvailable: boolean;
  manualSteps: string;
}

function analyzeRCA(results: CheckResult[]): Hypothesis[] | null {
  const failed = results.filter((r) => r.status === 'error');
  if (failed.length === 0) return null;

  const failedNames = new Set(failed.map((f) => f.service));

  // SES failure
  if (failedNames.has('aws_ses') && !failedNames.has('aws_sns')) {
    return [
      { cause: 'IAM policy missing ses:SendEmail on takeme-sms', confidence: 60, autofixAvailable: true, manualSteps: 'aws iam put-user-policy --user-name takeme-sms' },
      { cause: 'SES sandbox restriction — production access not enabled', confidence: 25, autofixAvailable: false, manualSteps: 'Request production access in SES console' },
      { cause: 'Email identity unverified for sender domain', confidence: 10, autofixAvailable: false, manualSteps: 'aws ses verify-email-identity --email' },
      { cause: 'Network egress policy blocking SES endpoint', confidence: 5, autofixAvailable: false, manualSteps: 'Check VPC/security group outbound rules' },
    ];
  }

  // SNS failure
  if (failedNames.has('aws_sns') && !failedNames.has('aws_ses')) {
    return [
      { cause: 'AWS SNS SMS permissions missing', confidence: 65, autofixAvailable: false, manualSteps: 'Add sns:Publish to IAM policy' },
      { cause: 'SNS sandbox — phone number not verified', confidence: 25, autofixAvailable: false, manualSteps: 'Verify phone in SNS sandbox console' },
      { cause: 'SMS spending limit reached', confidence: 10, autofixAvailable: false, manualSteps: 'Increase spend limit in SNS settings' },
    ];
  }

  // SES + SNS both down
  if (failedNames.has('aws_ses') && failedNames.has('aws_sns')) {
    return [
      { cause: 'AWS IAM credentials expired or revoked for takeme-sms', confidence: 70, autofixAvailable: false, manualSteps: 'Rotate AWS_ACCESS_KEY_ID in Vercel env' },
      { cause: 'AWS region misconfiguration', confidence: 20, autofixAvailable: false, manualSteps: 'Verify AWS_REGION matches SES/SNS region' },
      { cause: 'Account suspended by AWS', confidence: 10, autofixAvailable: false, manualSteps: 'Check AWS billing and account status' },
    ];
  }

  // Supabase DB + Auth
  if (failedNames.has('supabase_db') && failedNames.has('supabase_auth')) {
    return [
      { cause: 'Supabase project connectivity issue', confidence: 65, autofixAvailable: false, manualSteps: 'Check status.supabase.com and project dashboard' },
      { cause: 'DNS resolution failure for supabase.co', confidence: 20, autofixAvailable: false, manualSteps: 'Verify DNS from Vercel edge function region' },
      { cause: 'Service role key rotated without env update', confidence: 10, autofixAvailable: false, manualSteps: 'Copy new key from Supabase dashboard → Vercel env' },
      { cause: 'Vercel edge function region connectivity', confidence: 5, autofixAvailable: false, manualSteps: 'Check Vercel function region settings' },
    ];
  }

  // DB only
  if (failedNames.has('supabase_db') && !failedNames.has('supabase_auth')) {
    return [
      { cause: 'Supabase DB connection pool exhausted', confidence: 55, autofixAvailable: false, manualSteps: 'Check active connections in Supabase dashboard' },
      { cause: 'Service role key invalid', confidence: 30, autofixAvailable: false, manualSteps: 'Verify SUPABASE_SERVICE_ROLE_KEY in Vercel' },
      { cause: 'Database storage limit reached', confidence: 15, autofixAvailable: false, manualSteps: 'Check storage usage, upgrade plan if needed' },
    ];
  }

  // Stripe
  if (failedNames.has('stripe_api')) {
    return [
      { cause: 'Stripe API key invalid or rotated', confidence: 55, autofixAvailable: false, manualSteps: 'Verify STRIPE_SECRET_KEY in Vercel env' },
      { cause: 'Stripe rate limiting (too many requests)', confidence: 30, autofixAvailable: false, manualSteps: 'Check Stripe dashboard for rate limit status' },
      { cause: 'Stripe service degradation', confidence: 15, autofixAvailable: false, manualSteps: 'Check status.stripe.com' },
    ];
  }

  // Redis
  if (failedNames.has('upstash_redis')) {
    return [
      { cause: 'Upstash Redis connection dropped or token expired', confidence: 60, autofixAvailable: true, manualSteps: 'Verify UPSTASH_REDIS_REST_TOKEN in Vercel' },
      { cause: 'Redis memory limit reached', confidence: 25, autofixAvailable: false, manualSteps: 'Check Upstash dashboard for memory usage' },
      { cause: 'Upstash service outage', confidence: 15, autofixAvailable: false, manualSteps: 'Check status.upstash.com' },
    ];
  }

  // Multi-service
  if (failed.length >= 3) {
    return [
      { cause: 'Infrastructure outage — Vercel deployment or DNS failure', confidence: 55, autofixAvailable: false, manualSteps: 'Check Vercel status, DNS, and deployment logs' },
      { cause: 'Environment variables wiped during deployment', confidence: 25, autofixAvailable: false, manualSteps: 'Verify all env vars in Vercel project settings' },
      { cause: 'Upstream provider outage (AWS/Supabase/Stripe)', confidence: 20, autofixAvailable: false, manualSteps: 'Check status pages for all providers' },
    ];
  }

  // Generic fallback
  const svc = failed[0]?.service ?? 'unknown';
  return [
    { cause: `${svc} service failure — check configuration`, confidence: 60, autofixAvailable: false, manualSteps: 'Review service logs and credentials' },
    { cause: 'Transient network error', confidence: 25, autofixAvailable: false, manualSteps: 'Retry check in 60 seconds' },
    { cause: 'Configuration drift', confidence: 15, autofixAvailable: false, manualSteps: 'Run /api/monitor/policy to identify drift' },
  ];
}

// ── Blast radius ─────────────────────────────────────────────────────────

function getBlastRadius(service: string): string {
  const map: Record<string, string> = {
    supabase_db: 'All reads/writes, user profiles, ride history, bookings',
    supabase_auth: 'Login, signup, session refresh — all auth flows blocked',
    stripe_api: 'Payments, refunds, driver payouts — revenue impacted',
    stripe_webhook: 'Payment confirmations, subscription events — silent failures',
    aws_ses: 'Email OTP, verification emails, alerts — login via email broken',
    aws_sns: 'SMS OTP (Supabase+Twilio) — login via phone broken',
    upstash_redis: 'Dispatch queue, driver matching, rate limiting — rides broken',
    ably: 'Live driver tracking — riders see stale map',
    qstash: 'Async dispatch scheduling — delayed ride matching',
    page_home: 'Homepage down — new users cannot access site',
    page_login: 'Login page down — existing users locked out',
    page_students: 'Student page down — student signups blocked',
    api_health: 'Health endpoint down — external monitors may fire false alarms',
  };
  return map[service] ?? 'Unknown impact';
}

// ── Main handler ─────────────────────────────────────────────────────────

export async function GET(request: Request) {
  if (!verifyInternalRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const cronSecret = process.env.CRON_SECRET;

  const timestamp = new Date().toISOString();

  const results = await Promise.all([
    checkPage('page_home', '/'),
    checkPage('page_login', '/auth/login'),
    checkPage('page_students', '/students'),
    checkHealthAPI(),
    checkSupabaseDB(),
    checkSupabaseAuth(),
    checkStripeAPI(),
    checkStripeWebhook(),
    checkSES(),
    checkSNS(),
    checkRedis(),
    checkAbly(),
    checkQStash(),
  ]);

  const failures = results.filter((r) => r.status === 'error');
  const rca = analyzeRCA(results);

  // Determine customer impact level
  const criticalServices = new Set(['supabase_db', 'supabase_auth', 'stripe_api', 'upstash_redis']);
  const hasCritical = failures.some((f) => criticalServices.has(f.service));
  const impact = failures.length === 0 ? 'none' : hasCritical ? 'critical' : 'degraded';

  // Log to DB (non-blocking)
  const logPromise = (async () => {
    try {
      const sb = createServiceClient();
      await sb.from('monitoring_logs').insert(
        results.map((r) => ({
          service: r.service,
          status: r.status,
          latency_ms: r.latency_ms,
          error: r.error ?? null,
        })),
      );
    } catch (e) {
      console.error('[monitor] DB log failed:', (e as Error).message);
    }
  })();

  // Trigger alert if failures (non-blocking)
  const alertPromise = failures.length > 0
    ? fetch(`${APP_URL}/api/monitor/alert`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${cronSecret}`,
        },
        body: JSON.stringify({
          service: failures.map((f) => f.service).join(', '),
          error: failures.map((f) => `${f.service}: ${f.error}`).join('\n'),
          severity: hasCritical ? 'critical' : 'high',
        }),
      }).catch((e) => console.error('[monitor] Alert failed:', e))
    : Promise.resolve();

  // Auto-mode escalation (non-blocking)
  const modePromise = checkModeEscalation(results, Math.max(0, ...results.map(() => 0))).catch(() => {});

  await Promise.all([logPromise, alertPromise, modePromise]);

  console.log(`[monitor] ${timestamp} | ${impact.toUpperCase()} | ${failures.length} failures | ${results.map((r) => `${r.service}:${r.status}(${r.latency_ms}ms)`).join(' ')}`);

  return NextResponse.json({
    status: impact,
    timestamp,
    checks: results.map((r) => ({ ...r, blast_radius: r.status === 'error' ? getBlastRadius(r.service) : undefined })),
    failures: failures.length,
    rca,
  });
}
