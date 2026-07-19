import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';

type RouteContext = { params: Promise<{ id: string }> };

// GET /api/admin/rides/[id] — Full ride detail
export async function GET(_req: NextRequest, ctx: RouteContext) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const { id } = await ctx.params;
  const svc = createServiceClient();

  try {
    const [rideResult, eventsResult, fraudResult, routePointsResult] = await Promise.all([
      svc
        .from('rides')
        .select(`
          *,
          riders!rides_rider_id_fkey ( id, full_name, email, phone, rating, total_rides ),
          drivers!rides_assigned_driver_id_fkey ( id, full_name, email, phone, avatar_url, rating, total_trips, status ),
          vehicles!rides_vehicle_id_fkey ( id, vehicle_class, make, model, year, color, plate_number, capacity ),
          payments!payments_ride_id_fkey ( id, stripe_payment_intent, amount, currency, status, payment_method_type, created_at )
        `)
        .eq('id', id)
        .single(),
      svc
        .from('ride_events')
        .select('*')
        .eq('ride_id', id)
        .order('created_at', { ascending: true }),
      svc
        .from('trip_fraud_scores')
        .select('*')
        .eq('ride_id', id)
        .order('created_at', { ascending: false })
        .limit(1),
      svc
        .from('ride_route_points')
        .select('id, point_type, seq, place_name, formatted_address, lat, lng, leg_distance_km, leg_duration_min, status, arrived_at, completed_at')
        .eq('ride_id', id)
        .order('seq', { ascending: true }),
    ]);

    if (rideResult.error || !rideResult.data) {
      return NextResponse.json({ error: 'Ride not found' }, { status: 404 });
    }

    const ride = rideResult.data as Record<string, unknown>;

    return NextResponse.json({
      ride: {
        id: ride.id,
        status: ride.status,
        pickup_address: ride.pickup_address,
        pickup_lat: ride.pickup_lat,
        pickup_lng: ride.pickup_lng,
        dropoff_address: ride.dropoff_address,
        dropoff_lat: ride.dropoff_lat,
        dropoff_lng: ride.dropoff_lng,
        vehicle_class: ride.vehicle_class,
        distance_km: ride.distance_km,
        duration_min: ride.duration_min,
        route_polyline: ride.route_polyline,
        estimated_fare: ride.estimated_fare,
        final_fare: ride.final_fare,
        surge_multiplier: ride.surge_multiplier,
        cancel_reason: ride.cancel_reason,
        cancelled_by: ride.cancelled_by,
        cancelled_at: ride.cancelled_at,
        requested_at: ride.requested_at,
        driver_assigned_at: ride.driver_assigned_at,
        driver_arrived_at: ride.driver_arrived_at,
        trip_started_at: ride.trip_started_at,
        trip_completed_at: ride.trip_completed_at,
        rider_rating: ride.rider_rating,
        driver_rating: ride.driver_rating,
        created_at: ride.created_at,
      },
      rider: ride.riders ?? null,
      driver: ride.drivers ?? null,
      vehicle: ride.vehicles ?? null,
      payment: ride.payments ?? null,
      events: eventsResult.data ?? [],
      fraud_score: fraudResult.data?.[0] ?? null,
      // Ordered multi-stop itinerary; empty for single-destination rides.
      route_points: routePointsResult.data ?? [],
    });
  } catch (err) {
    console.error('[admin/rides/id]', err);
    return NextResponse.json({ error: 'Failed to fetch ride detail' }, { status: 500 });
  }
}
