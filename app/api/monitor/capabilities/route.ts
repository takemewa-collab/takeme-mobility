import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { verifyInternalRequest } from '@/lib/auth/internal-auth';
import { SESClient, ListIdentitiesCommand } from '@aws-sdk/client-ses';
import { SNSClient, GetSMSAttributesCommand } from '@aws-sdk/client-sns';

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/monitor/capabilities
//
// Tests each operational capability in isolation:
// email, SMS, DB write, auth, queue scheduling.
// ═══════════════════════════════════════════════════════════════════════════

interface Capability {
  name: string;
  status: 'ok' | 'fail';
  latency_ms: number;
  error?: string;
}

async function testCap(name: string, fn: () => Promise<void>): Promise<Capability> {
  const start = Date.now();
  try {
    await fn();
    return { name, status: 'ok', latency_ms: Date.now() - start };
  } catch (e: unknown) {
    return { name, status: 'fail', latency_ms: Date.now() - start, error: (e as Error).message };
  }
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

export async function GET(request: Request) {
  if (!verifyInternalRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const results = await Promise.all([
    // Email capability
    testCap('email', async () => {
      if (!process.env.AWS_ACCESS_KEY_ID) throw new Error('AWS credentials not set');
      const ses = new SESClient(getAWSConfig());
      await ses.send(new ListIdentitiesCommand({ MaxItems: 1 }));
    }),

    // SMS capability
    testCap('sms', async () => {
      if (!process.env.AWS_ACCESS_KEY_ID) throw new Error('AWS credentials not set');
      const sns = new SNSClient(getAWSConfig());
      await sns.send(new GetSMSAttributesCommand({ attributes: ['DefaultSMSType'] }));
    }),

    // DB write capability
    testCap('db_write', async () => {
      const sb = createServiceClient();
      const { data, error: insertErr } = await sb
        .from('monitoring_logs')
        .insert({ service: '_capability_test', status: 'ok', latency_ms: 0 })
        .select('id')
        .single();
      if (insertErr) throw new Error(insertErr.message);
      // Clean up
      await sb.from('monitoring_logs').delete().eq('id', data.id);
    }),

    // Auth capability
    testCap('auth', async () => {
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
      if (!url) throw new Error('SUPABASE_URL not set');
      const res = await fetch(`${url}/auth/v1/settings`, {
        headers: { 'apikey': process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    }),

    // Queue capability
    testCap('queue', async () => {
      const token = process.env.US_EAST_1_QSTASH_TOKEN ?? process.env.QSTASH_TOKEN;
      if (!token) throw new Error('QStash token not set');
      const baseUrl = process.env.US_EAST_1_QSTASH_URL ?? 'https://qstash.upstash.io';
      const res = await fetch(`${baseUrl}/v2/messages`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
    }),
  ]);

  const capMap: Record<string, Capability> = {};
  results.forEach((r) => { capMap[r.name] = r; });

  return NextResponse.json({
    timestamp: new Date().toISOString(),
    capabilities: capMap,
    all_operational: results.every((r) => r.status === 'ok'),
  });
}
