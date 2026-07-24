import { NextRequest, NextResponse } from 'next/server';
import { createApiClient } from '@/lib/supabase/api';
import { createServiceClient } from '@/lib/supabase/service';

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/driver/trips?filter=all|completed|cancelled&before=<ISO>&limit=N
//
// The driver's trip history, newest first, keyset-paginated on requested_at.
// Earnings per trip come from the driver_transactions ledger (never
// recomputed client-side). Deliberately excludes rider PII — no rider name,
// phone, or rating; addresses are the driver's own trip record.
// ═══════════════════════════════════════════════════════════════════════════

const FILTERS: Record<string, string[]> = {
  all: ['completed', 'cancelled'],
  completed: ['completed'],
  cancelled: ['cancelled'],
};

export async function GET(request: NextRequest) {
  try {
    const { user } = await createApiClient(request);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const svc = createServiceClient();

    const { data: driver } = await svc
      .from('drivers')
      .select('id')
      .eq('auth_user_id', user.id)
      .maybeSingle();
    if (!driver) return NextResponse.json({ error: 'Not a driver' }, { status: 404 });

    const params = request.nextUrl.searchParams;
    const statuses = FILTERS[params.get('filter') ?? 'all'] ?? FILTERS.all;
    const limit = Math.min(50, Math.max(1, Number(params.get('limit') ?? 25)));
    const before = params.get('before');

    let query = svc
      .from('rides')
      .select(
        'id, status, vehicle_class, pickup_address, dropoff_address, estimated_fare, final_fare, surge_multiplier, distance_km, duration_min, requested_at, trip_started_at, trip_completed_at, cancelled_at, cancel_reason, cancelled_by',
      )
      .eq('assigned_driver_id', driver.id)
      .in('status', statuses)
      .order('requested_at', { ascending: false })
      .limit(limit);
    if (before) query = query.lt('requested_at', before);

    const { data: rides, error } = await query;
    if (error) throw error;

    // Ledger truth for each trip's earnings (ride_earning + tips + ride
    // adjustments), one batched read.
    const rideIds = (rides ?? []).map((r) => r.id);
    const { data: ledger } = rideIds.length
      ? await svc
          .from('driver_transactions')
          .select('ride_id, type, amount')
          .eq('driver_id', user.id)
          .in('ride_id', rideIds)
      : { data: [] as { ride_id: string; type: string; amount: number }[] };

    const earningsByRide = new Map<string, { earningsUsd: number; tipsUsd: number }>();
    for (const row of ledger ?? []) {
      if (!row.ride_id) continue;
      const entry = earningsByRide.get(row.ride_id) ?? { earningsUsd: 0, tipsUsd: 0 };
      const amount = Number(row.amount);
      if (row.type === 'tip') entry.tipsUsd += amount;
      else if (row.type === 'ride_earning' || row.type === 'adjustment') entry.earningsUsd += amount;
      earningsByRide.set(row.ride_id, entry);
    }

    const trips = (rides ?? []).map((r) => {
      const earned = earningsByRide.get(r.id);
      return {
        id: r.id,
        status: r.status,
        vehicleClass: r.vehicle_class,
        pickupAddress: r.pickup_address,
        dropoffAddress: r.dropoff_address,
        fareUsd: r.final_fare != null ? Number(r.final_fare) : Number(r.estimated_fare ?? 0),
        surgeMultiplier: Number(r.surge_multiplier ?? 1),
        distanceKm: r.distance_km != null ? Number(r.distance_km) : null,
        durationMin: r.duration_min != null ? Number(r.duration_min) : null,
        requestedAt: r.requested_at,
        startedAt: r.trip_started_at,
        completedAt: r.trip_completed_at,
        cancelledAt: r.cancelled_at,
        cancelReason: r.cancel_reason,
        cancelledBy: r.cancelled_by,
        earningsUsd: earned ? Math.round((earned.earningsUsd + earned.tipsUsd) * 100) / 100 : null,
        tipsUsd: earned ? Math.round(earned.tipsUsd * 100) / 100 : null,
        // Earnings settle into the wallet at completion — payout state is a
        // wallet property, not a per-trip one.
        payoutStatus: r.status === 'completed' && earned ? 'included_in_balance' : null,
      };
    });

    return NextResponse.json({
      trips,
      nextBefore: rides && rides.length === limit ? rides[rides.length - 1].requested_at : null,
    });
  } catch (err) {
    console.error('GET /api/driver/trips failed:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
