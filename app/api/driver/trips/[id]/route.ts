import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createApiClient } from '@/lib/supabase/api';
import { createServiceClient } from '@/lib/supabase/service';
import { driverEarningsRate } from '@/lib/earnings';

// ═══════════════════════════════════════════════════════════════════════════
// GET  /api/driver/trips/[id] — the driver's receipt for one of THEIR trips:
//      fare, share rate, ledger breakdown, milestone timeline. No rider PII.
// POST /api/driver/trips/[id] — report an issue with the trip. Recorded as a
//      ride_event (auditable) + a notification acknowledging receipt.
// ═══════════════════════════════════════════════════════════════════════════

async function resolveOwnRide(request: NextRequest, rideId: string) {
  const { user } = await createApiClient(request);
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  const svc = createServiceClient();
  const { data: driver } = await svc
    .from('drivers')
    .select('id')
    .eq('auth_user_id', user.id)
    .maybeSingle();
  if (!driver) return { error: NextResponse.json({ error: 'Not a driver' }, { status: 404 }) };
  const { data: ride } = await svc
    .from('rides')
    .select(
      'id, status, assigned_driver_id, vehicle_class, pickup_address, dropoff_address, estimated_fare, final_fare, surge_multiplier, distance_km, duration_min, requested_at, driver_assigned_at, driver_arrived_at, trip_started_at, trip_completed_at, cancelled_at, cancel_reason, cancelled_by',
    )
    .eq('id', rideId)
    .maybeSingle();
  if (!ride || ride.assigned_driver_id !== driver.id) {
    return { error: NextResponse.json({ error: 'Trip not found' }, { status: 404 }) };
  }
  return { user, driver, ride, svc };
}

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const resolved = await resolveOwnRide(request, id);
    if ('error' in resolved) return resolved.error;
    const { user, ride, svc } = resolved;

    const { data: ledger } = await svc
      .from('driver_transactions')
      .select('type, amount, description, created_at')
      .eq('driver_id', user.id)
      .eq('ride_id', ride.id)
      .order('created_at', { ascending: true });

    const fareUsd = ride.final_fare != null ? Number(ride.final_fare) : Number(ride.estimated_fare ?? 0);
    const breakdown = (ledger ?? []).map((row) => ({
      type: row.type,
      amountUsd: Number(row.amount),
      description: row.description,
      at: row.created_at,
    }));
    const earningsUsd = breakdown.reduce(
      (s, b) => (b.type === 'ride_earning' || b.type === 'tip' || b.type === 'adjustment' ? s + b.amountUsd : s),
      0,
    );

    return NextResponse.json({
      trip: {
        id: ride.id,
        status: ride.status,
        vehicleClass: ride.vehicle_class,
        pickupAddress: ride.pickup_address,
        dropoffAddress: ride.dropoff_address,
        fareUsd,
        surgeMultiplier: Number(ride.surge_multiplier ?? 1),
        distanceKm: ride.distance_km != null ? Number(ride.distance_km) : null,
        durationMin: ride.duration_min != null ? Number(ride.duration_min) : null,
        cancelReason: ride.cancel_reason,
        cancelledBy: ride.cancelled_by,
        timeline: {
          requestedAt: ride.requested_at,
          acceptedAt: ride.driver_assigned_at,
          arrivedAt: ride.driver_arrived_at,
          startedAt: ride.trip_started_at,
          completedAt: ride.trip_completed_at,
          cancelledAt: ride.cancelled_at,
        },
      },
      earnings: {
        totalUsd: Math.round(earningsUsd * 100) / 100,
        shareRate: driverEarningsRate(),
        breakdown,
      },
    });
  } catch (err) {
    console.error('GET /api/driver/trips/[id] failed:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}

const issueSchema = z.object({
  category: z.enum(['safety', 'payment', 'rider_behavior', 'app_issue', 'other']),
  message: z.string().min(5).max(2000),
});

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const resolved = await resolveOwnRide(request, id);
    if ('error' in resolved) return resolved.error;
    const { user, driver, ride, svc } = resolved;

    const body = issueSchema.parse(await request.json());

    const { error: insertError } = await svc.from('ride_events').insert({
      ride_id: ride.id,
      event_type: 'driver_issue_report',
      actor: 'driver',
      metadata: { driver_id: driver.id, category: body.category, message: body.message },
    });
    if (insertError) throw insertError;

    await svc.from('driver_notifications').insert({
      user_id: user.id,
      category: body.category === 'safety' ? 'safety' : 'ride',
      title: 'Issue report received',
      body:
        body.category === 'safety'
          ? 'Our safety team will review your report and follow up.'
          : 'Thanks — our support team will review your report.',
      data: { rideId: ride.id, category: body.category },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }
    console.error('POST /api/driver/trips/[id] failed:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
