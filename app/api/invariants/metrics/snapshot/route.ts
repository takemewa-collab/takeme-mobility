import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { verifyInternalRequest } from '@/lib/auth/internal-auth';
import { getAllMetrics } from '@/lib/invariants/metrics';

// GET /api/invariants/metrics/snapshot — Daily cron to save metric snapshot
export async function GET(request: Request) {
  if (!verifyInternalRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const metrics = await getAllMetrics();
  const svc = createServiceClient();
  const today = new Date().toISOString().slice(0, 10);

  for (const m of metrics) {
    try {
      await svc.from('invariant_metrics_log').upsert({
        invariant: m.name,
        date: today,
        violations: m.violations_today,
        near_misses: m.near_misses_today,
        shadow_violations: m.shadow_violations,
        avg_recovery_ms: m.avg_recovery_time_ms,
      }, { onConflict: 'invariant,date' });
    } catch { /* non-critical */ }
  }

  return NextResponse.json({ saved: metrics.length, date: today });
}
