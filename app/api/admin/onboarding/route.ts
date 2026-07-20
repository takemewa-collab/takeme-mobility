import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/admin/onboarding — the driver-application review queue.
// Filters: status, marketKey, applicantType, queue=review|expiring|all.
// Aggregates per-application requirement counts so the queue shows what
// actually needs a reviewer, oldest submission first.
// ═══════════════════════════════════════════════════════════════════════════

export async function GET(request: NextRequest) {
  const { user, error } = await requireAdmin();
  if (error || !user) return error!;

  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const marketKey = url.searchParams.get('marketKey');
  const applicantType = url.searchParams.get('applicantType');
  const queue = url.searchParams.get('queue') ?? 'all';
  const search = url.searchParams.get('search')?.trim();
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 200);

  const svc = createServiceClient();

  let marketId: string | null = null;
  if (marketKey) {
    const { data: market } = await svc
      .from('onboarding_markets')
      .select('id')
      .eq('key', marketKey)
      .maybeSingle();
    marketId = market?.id ?? null;
    if (!marketId) return NextResponse.json({ applications: [] });
  }

  let query = svc
    .from('driver_applications')
    .select('id, user_id, full_name, phone, email, status, applicant_type, vehicle_relationship, market_id, vehicle_make, vehicle_model, vehicle_year, created_at, submitted_at, updated_at')
    .order('created_at', { ascending: true })
    .limit(limit);
  if (status) query = query.eq('status', status);
  else query = query.in('status', ['in_progress', 'pending', 'approved']);
  if (marketId) query = query.eq('market_id', marketId);
  if (applicantType) query = query.eq('applicant_type', applicantType);
  if (search) query = query.or(`full_name.ilike.%${search}%,phone.ilike.%${search}%,email.ilike.%${search}%`);

  const { data: applications } = await query;
  if (!applications || applications.length === 0) {
    return NextResponse.json({ applications: [] });
  }

  const appIds = applications.map((a) => a.id);
  const { data: reqRows } = await svc
    .from('application_requirements')
    .select('application_id, status, required, blocking, expires_at, updated_at')
    .in('application_id', appIds);

  const now = Date.now();
  const soonMs = 30 * 24 * 60 * 60 * 1000;
  const byApp = new Map<string, { review: number; needsAction: number; expiring: number; open: number; total: number; oldestReviewAt: string | null }>();
  for (const r of reqRows ?? []) {
    const agg = byApp.get(r.application_id) ?? {
      review: 0, needsAction: 0, expiring: 0, open: 0, total: 0, oldestReviewAt: null,
    };
    agg.total += 1;
    if (['submitted', 'under_review'].includes(r.status)) {
      agg.review += 1;
      if (!agg.oldestReviewAt || r.updated_at < agg.oldestReviewAt) agg.oldestReviewAt = r.updated_at;
    }
    if (['needs_action', 'rejected'].includes(r.status)) agg.needsAction += 1;
    if (r.expires_at) {
      const t = new Date(r.expires_at).getTime();
      if (t < now + soonMs) agg.expiring += 1;
    }
    if (r.required && r.blocking && !['approved', 'waived', 'not_applicable'].includes(r.status)) {
      agg.open += 1;
    }
    byApp.set(r.application_id, agg);
  }

  const marketsById = new Map<string, string>();
  {
    const { data: markets } = await svc.from('onboarding_markets').select('id, display_name');
    for (const m of markets ?? []) marketsById.set(m.id, m.display_name);
  }

  let rows = applications.map((a) => ({
    id: a.id,
    userId: a.user_id,
    fullName: a.full_name,
    phone: a.phone,
    email: a.email,
    status: a.status,
    applicantType: a.applicant_type,
    vehicleRelationship: a.vehicle_relationship,
    market: a.market_id ? marketsById.get(a.market_id) ?? null : null,
    vehicle: a.vehicle_make ? `${a.vehicle_year ?? ''} ${a.vehicle_make} ${a.vehicle_model ?? ''}`.trim() : null,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
    counts: byApp.get(a.id) ?? { review: 0, needsAction: 0, expiring: 0, open: 0, total: 0, oldestReviewAt: null },
  }));

  if (queue === 'review') rows = rows.filter((r) => r.counts.review > 0);
  if (queue === 'expiring') rows = rows.filter((r) => r.counts.expiring > 0);
  rows.sort((a, b) => {
    const ta = a.counts.oldestReviewAt ?? a.updatedAt;
    const tb = b.counts.oldestReviewAt ?? b.updatedAt;
    return ta < tb ? -1 : 1;
  });

  return NextResponse.json({ applications: rows });
}
