import { NextRequest, NextResponse } from 'next/server';
import { createApiClient } from '@/lib/supabase/api';
import { createServiceClient } from '@/lib/supabase/service';

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/driver/incentives — REAL configured incentive programs only
// (ride-count goals, time-window bonuses, geo bonuses, referrals) plus this
// driver's progress. The tables ship empty; until operations configures a
// program the response is an honest empty list — the app renders an
// intentional empty state, never sample goals. Any prioritization/bonus
// logic must remain transparent and auditable (programs are immutable rows
// with explicit config and validity windows).
// ═══════════════════════════════════════════════════════════════════════════

export async function GET(request: NextRequest) {
  try {
    const { user } = await createApiClient(request);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const svc = createServiceClient();

    const nowIso = new Date().toISOString();
    const { data: programs } = await svc
      .from('incentive_programs')
      .select('id, program_key, title, description, program_type, config, starts_at, ends_at')
      .eq('is_active', true)
      .lte('starts_at', nowIso)
      .gte('ends_at', nowIso)
      .order('ends_at', { ascending: true });

    const programIds = (programs ?? []).map((p) => p.id);
    const { data: progress } = programIds.length
      ? await svc
          .from('driver_incentive_progress')
          .select('program_id, progress, earned_amount, status')
          .eq('user_id', user.id)
          .in('program_id', programIds)
      : { data: [] as { program_id: string; progress: unknown; earned_amount: number; status: string }[] };

    const progressByProgram = new Map((progress ?? []).map((p) => [p.program_id, p]));

    return NextResponse.json({
      programs: (programs ?? []).map((p) => ({
        id: p.id,
        key: p.program_key,
        title: p.title,
        description: p.description,
        type: p.program_type,
        config: p.config,
        startsAt: p.starts_at,
        endsAt: p.ends_at,
        progress: progressByProgram.get(p.id)?.progress ?? null,
        earnedUsd: Number(progressByProgram.get(p.id)?.earned_amount ?? 0),
        status: progressByProgram.get(p.id)?.status ?? 'in_progress',
      })),
    });
  } catch (err) {
    console.error('GET /api/driver/incentives failed:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
