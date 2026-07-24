import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { verifyInternalRequest } from '@/lib/auth/internal-auth';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/monitor/e2e
//
// Full synthetic transaction — creates and tears down real resources
// to verify the entire stack works end-to-end.
// Runs every 5 minutes via Vercel Cron.
// ═══════════════════════════════════════════════════════════════════════════

const ALERT_EMAIL = 'acilholding@gmail.com';

interface E2EStep {
  step: string;
  status: 'pass' | 'fail' | 'skip';
  duration_ms: number;
  error?: string;
}

async function runStep(step: string, fn: () => Promise<void>): Promise<E2EStep> {
  const start = Date.now();
  try {
    await fn();
    return { step, status: 'pass', duration_ms: Date.now() - start };
  } catch (e: unknown) {
    return { step, status: 'fail', duration_ms: Date.now() - start, error: (e as Error).message };
  }
}

export async function GET(request: Request) {
  if (!verifyInternalRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const sb = createServiceClient();
  const steps: E2EStep[] = [];

  // Step 1: Supabase Auth check
  steps.push(await runStep('supabase_auth_settings', async () => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (!url) throw new Error('URL not set');
    const res = await fetch(`${url}/auth/v1/settings`, {
      headers: { 'apikey': process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }));

  // Step 2: DB write + read + delete (synthetic ride booking)
  let testRowId: string | null = null;
  steps.push(await runStep('db_write_read_delete', async () => {
    // Insert a test monitoring log as our synthetic "booking"
    const { data, error: insertErr } = await sb
      .from('monitoring_e2e')
      .insert({ step: '_e2e_synthetic_test', status: 'pass', duration_ms: 0 })
      .select('id')
      .single();
    if (insertErr) throw new Error(`INSERT: ${insertErr.message}`);
    testRowId = data.id;

    // Read it back
    const { error: readErr } = await sb
      .from('monitoring_e2e')
      .select('id')
      .eq('id', testRowId)
      .single();
    if (readErr) throw new Error(`SELECT: ${readErr.message}`);

    // Delete it
    const { error: delErr } = await sb
      .from('monitoring_e2e')
      .delete()
      .eq('id', testRowId);
    if (delErr) throw new Error(`DELETE: ${delErr.message}`);
    testRowId = null;
  }));

  // Step 3: Stripe connectivity. LIVE keys get a READ-ONLY authenticated
  // check (GET /v1/balance) — never creates/cancels live objects; the
  // synthetic $1 create+cancel cycle runs only against sk_test_ keys.
  // See lib/monitoring/stripe-check.ts.
  steps.push(await runStep('stripe_payment_cycle', async () => {
    const { runStripeCheck } = await import('@/lib/monitoring/stripe-check');
    await runStripeCheck(process.env.STRIPE_SECRET_KEY ?? '');
  }));

  // Step 3b: Stripe CONNECT readiness — driver payouts depend on Connect
  // being enabled for the platform account. Read-only: lists connected
  // accounts (limit 1). Fails with Stripe's exact message when the platform
  // has not signed up for Connect — the precise root cause when driver
  // payout onboarding cannot create accounts.
  steps.push(await runStep('stripe_connect_ready', async () => {
    const key = process.env.STRIPE_SECRET_KEY ?? '';
    if (!key) throw new Error('STRIPE_SECRET_KEY not set');
    const res = await fetch('https://api.stripe.com/v1/accounts?limit=1', {
      headers: { Authorization: `Bearer ${key}` },
    });
    const data = (await res.json()) as { error?: { message?: string } };
    if (!res.ok) {
      throw new Error(data?.error?.message ?? `Stripe accounts list failed (${res.status})`);
    }
  }));

  // Step 4: Redis write + read + delete
  steps.push(await runStep('redis_write_read_delete', async () => {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) throw new Error('Redis credentials not set');
    const headers = { 'Authorization': `Bearer ${token}` };
    const testKey = `e2e:test:${Date.now()}`;

    // SET
    const setRes = await fetch(`${url}/set/${testKey}/ok/ex/10`, { headers });
    if (!setRes.ok) throw new Error(`SET: HTTP ${setRes.status}`);

    // GET
    const getRes = await fetch(`${url}/get/${testKey}`, { headers });
    if (!getRes.ok) throw new Error(`GET: HTTP ${getRes.status}`);
    const val = await getRes.json();
    if (val.result !== 'ok') throw new Error(`GET: expected 'ok', got '${val.result}'`);

    // DEL
    const delRes = await fetch(`${url}/del/${testKey}`, { headers });
    if (!delRes.ok) throw new Error(`DEL: HTTP ${delRes.status}`);
  }));

  // Clean up test row if still exists (safety net)
  if (testRowId) {
    try { await sb.from('monitoring_e2e').delete().eq('id', testRowId); } catch { /* cleanup */ }
  }

  // ── Email policy: never on routine success ──────────────────────────
  // Only a failing run, a failing→healthy recovery, or an explicitly
  // configured digest (MONITOR_DIGEST_HOURS) sends the SES email.
  const coreFailed = steps.filter((s) => s.status === 'fail').length;

  // Previous run's health, read BEFORE this run's rows are inserted.
  // Rows within 10s of the newest row belong to the same (previous) run.
  // ses_send_email is excluded: health means the CORE checks (auth, DB,
  // Stripe, Redis). If the alert channel itself is down, treating that as
  // "unhealthy" would fire a recovery-email attempt every 5 minutes forever;
  // SES failures stay visible in monitoring_e2e without driving the policy.
  let previousRunHealthy: boolean | null = null;
  try {
    const { data: prevRows } = await sb
      .from('monitoring_e2e')
      .select('step, status, created_at')
      .not('step', 'in', '("_e2e_synthetic_test","_digest_email_sent","ses_send_email")')
      .order('created_at', { ascending: false })
      .limit(10);
    if (prevRows && prevRows.length > 0) {
      const newest = new Date(prevRows[0].created_at).getTime();
      const prevRun = prevRows.filter(
        (r) => Math.abs(new Date(r.created_at).getTime() - newest) <= 10_000,
      );
      previousRunHealthy = prevRun.every((r) => r.status === 'pass');
    }
  } catch { /* no history — stay null */ }

  const digestEveryHours = Number(process.env.MONITOR_DIGEST_HOURS ?? '') || null;
  let lastDigestAt: Date | null = null;
  if (digestEveryHours) {
    const { data: digestRow } = await sb
      .from('monitoring_e2e')
      .select('created_at')
      .eq('step', '_digest_email_sent')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    lastDigestAt = digestRow ? new Date(digestRow.created_at) : null;
  }

  const { monitorEmailReason } = await import('@/lib/monitoring/email-policy');
  const emailReason = monitorEmailReason({
    currentFailed: coreFailed,
    previousRunHealthy,
    digestEveryHours,
    lastDigestAt,
  });

  if (emailReason) {
    steps.push(await runStep('ses_send_email', async () => {
      if (!process.env.AWS_ACCESS_KEY_ID) throw new Error('AWS credentials not set');
      const ses = new SESClient({
        region: process.env.AWS_REGION ?? 'us-east-1',
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
        },
      });
      const failing = steps.filter((s) => s.status === 'fail');
      const subject =
        emailReason === 'failure'
          ? `[TakeMe E2E] FAILURE — ${failing.length} step(s) failing`
          : emailReason === 'recovery'
            ? '[TakeMe E2E] Recovered — all checks passing'
            : '[TakeMe E2E] Digest — all checks passing';
      const lines = steps.map((s) => `${s.step}: ${s.status}${s.error ? ` (${s.error})` : ''}`);
      await ses.send(new SendEmailCommand({
        Source: process.env.SES_FROM_EMAIL ?? 'acilholding@gmail.com',
        Destination: { ToAddresses: [ALERT_EMAIL] },
        Message: {
          Subject: { Data: subject },
          Body: {
            Text: { Data: `${subject}\nat ${new Date().toISOString()}\n\n${lines.join('\n')}` },
          },
        },
      }));
    }));
    if (emailReason === 'digest') {
      try {
        await sb.from('monitoring_e2e').insert({ step: '_digest_email_sent', status: 'pass', duration_ms: 0 });
      } catch { /* marker is best-effort */ }
    }
  }

  // Save results to DB
  const passed = steps.filter((s) => s.status === 'pass').length;
  const failed = steps.filter((s) => s.status === 'fail').length;

  try {
    await sb.from('monitoring_e2e').insert(
      steps.map((s) => ({
        step: s.step,
        status: s.status,
        duration_ms: s.duration_ms,
        error: s.error ?? null,
      })),
    );
  } catch (e) {
    console.error('[e2e] DB log failed:', e);
  }

  console.log(`[e2e] ${passed} passed, ${failed} failed | ${steps.map((s) => `${s.step}:${s.status}(${s.duration_ms}ms)`).join(' ')}`);

  // ── History, percentiles, trends ────────────────────────────────────
  const { data: historyRows } = await sb
    .from('monitoring_e2e')
    .select('step, status, duration_ms, created_at')
    .order('created_at', { ascending: false })
    .limit(500); // ~100 runs × 5 steps

  // Group into runs by timestamp (entries within 10s = same run)
  const runs: Array<{ timestamp: string; steps: Array<{ step: string; status: string; duration_ms: number }> }> = [];
  let currentRun: typeof runs[0] | null = null;

  for (const row of historyRows ?? []) {
    if (!currentRun || Math.abs(new Date(row.created_at).getTime() - new Date(currentRun.timestamp).getTime()) > 10_000) {
      currentRun = { timestamp: row.created_at, steps: [] };
      runs.push(currentRun);
    }
    if (row.step !== '_e2e_synthetic_test' && row.step !== '_digest_email_sent') {
      currentRun.steps.push({ step: row.step, status: row.status, duration_ms: row.duration_ms });
    }
  }

  // Only keep runs with actual steps
  const validRuns = runs.filter(r => r.steps.length > 0).slice(0, 10);

  // Calculate success rate
  const passedRuns = validRuns.filter(r => r.steps.every(s => s.status === 'pass')).length;
  const successRate = validRuns.length > 0 ? Math.round((passedRuns / validRuns.length) * 100) : 0;

  // Percentiles from all step durations
  const allDurations = validRuns.flatMap(r => r.steps.map(s => s.duration_ms)).sort((a, b) => a - b);
  const percentile = (arr: number[], p: number) => arr.length === 0 ? 0 : arr[Math.min(Math.floor(arr.length * p / 100), arr.length - 1)];
  const p50 = percentile(allDurations, 50);
  const p95 = percentile(allDurations, 95);
  const p99 = percentile(allDurations, 99);

  // Failure pattern: which step fails most consistently
  const stepFailCounts: Record<string, number> = {};
  validRuns.forEach(r => r.steps.forEach(s => { if (s.status === 'fail') stepFailCounts[s.step] = (stepFailCounts[s.step] ?? 0) + 1; }));
  const topFailing = Object.entries(stepFailCounts).sort(([, a], [, b]) => b - a)[0];
  const failurePattern = topFailing ? `${topFailing[0].replace(/_/g, ' ')} failing (${topFailing[1]}/${validRuns.length} runs)` : null;

  // Trend: compare last 3 vs previous 3
  const last3 = validRuns.slice(0, 3);
  const prev3 = validRuns.slice(3, 6);
  const last3Pass = last3.filter(r => r.steps.every(s => s.status === 'pass')).length;
  const prev3Pass = prev3.filter(r => r.steps.every(s => s.status === 'pass')).length;
  const trend = prev3.length === 0 ? 'stable' : last3Pass > prev3Pass ? 'improving' : last3Pass < prev3Pass ? 'degrading' : 'stable';

  return NextResponse.json({
    status: failed === 0 ? 'pass' : 'fail',
    timestamp: new Date().toISOString(),
    steps,
    summary: { passed, failed, total: steps.length },
    history: validRuns.map(r => ({
      timestamp: r.timestamp,
      pass: r.steps.every(s => s.status === 'pass'),
      totalDuration: r.steps.reduce((a, s) => a + s.duration_ms, 0),
      steps: r.steps,
    })),
    stats: { successRate, p50, p95, p99, failurePattern, trend },
  });
}
