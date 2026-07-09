import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { verifyInternalRequest } from '@/lib/auth/internal-auth';
import { IAMClient, PutUserPolicyCommand } from '@aws-sdk/client-iam';

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/monitor/autofix
// GET  /api/monitor/autofix  (cron trigger)
//
// Auto-recovery engine. Detects failures and applies known fixes.
// Logs every attempt to monitoring_fixes table.
// ═══════════════════════════════════════════════════════════════════════════

const APP_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://takememobility.com';

interface FixResult {
  service: string;
  fix_applied: string;
  success: boolean;
  error?: string;
}

function getAWSConfig() {
  return {
    region: process.env.AWS_REGION ?? 'us-east-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  };
}

async function fixSES(): Promise<FixResult> {
  const fix = 'iam:PutUserPolicy ses:SendEmail+ses:SendRawEmail on takeme-sms';
  try {
    const iam = new IAMClient(getAWSConfig());
    await iam.send(new PutUserPolicyCommand({
      UserName: 'takeme-sms',
      PolicyName: 'AllowSESSendEmail',
      PolicyDocument: JSON.stringify({
        Version: '2012-10-17',
        Statement: [{
          Effect: 'Allow',
          Action: ['ses:SendEmail', 'ses:SendRawEmail'],
          Resource: '*',
        }],
      }),
    }));
    return { service: 'aws_ses', fix_applied: fix, success: true };
  } catch (e) {
    return { service: 'aws_ses', fix_applied: fix, success: false, error: (e as Error).message };
  }
}

async function fixRedis(): Promise<FixResult> {
  const fix = 'Redis PING to verify connectivity and force reconnect';
  try {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) throw new Error('Redis credentials not set');

    // Ping to force reconnect — don't flushall in production
    const res = await fetch(`${url}/ping`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`PING failed: HTTP ${res.status}`);
    return { service: 'upstash_redis', fix_applied: fix, success: true };
  } catch (e) {
    return { service: 'upstash_redis', fix_applied: fix, success: false, error: (e as Error).message };
  }
}

async function handler(request: Request) {
  if (!verifyInternalRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const cronSecret = process.env.CRON_SECRET;

  // First, get current health status
  let healthData: { checks?: Array<{ service: string; status: string }> } = {};
  try {
    const res = await fetch(`${APP_URL}/api/monitor`, {
      headers: cronSecret ? { 'Authorization': `Bearer ${cronSecret}` } : {},
      cache: 'no-store',
    });
    if (res.ok) healthData = await res.json();
  } catch {
    // If monitor itself is down, try fixes anyway
  }

  const failedServices = new Set(
    (healthData.checks ?? []).filter((c) => c.status === 'error').map((c) => c.service),
  );

  const fixed: FixResult[] = [];
  const failed: FixResult[] = [];
  const skipped: string[] = [];

  // SES fix
  if (failedServices.has('aws_ses')) {
    const result = await fixSES();
    (result.success ? fixed : failed).push(result);
  } else {
    skipped.push('aws_ses');
  }

  // Redis fix
  if (failedServices.has('upstash_redis')) {
    const result = await fixRedis();
    (result.success ? fixed : failed).push(result);
  } else {
    skipped.push('upstash_redis');
  }

  // Log all fix attempts to DB
  const sb = createServiceClient();
  const allAttempts = [...fixed, ...failed];
  if (allAttempts.length > 0) {
    try {
      await sb.from('monitoring_fixes').insert(
        allAttempts.map((r) => ({
          service: r.service,
          fix_applied: r.fix_applied,
          success: r.success,
        })),
      );
    } catch (e) {
      console.error('[autofix] DB log failed:', e);
    }
  }

  console.log(`[autofix] fixed=${fixed.length} failed=${failed.length} skipped=${skipped.length}`);

  return NextResponse.json({ fixed, failed, skipped });
}

export const GET = handler;
export const POST = handler;
