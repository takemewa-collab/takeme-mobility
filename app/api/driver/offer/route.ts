import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createApiClient } from '@/lib/supabase/api';
import { createServiceClient } from '@/lib/supabase/service';
import { getActiveOfferForDriver } from '@/lib/redis';
import { driverShare } from '@/lib/earnings';
import { haversineMeters, parseGeoPoint } from '@/lib/trip-geofence';

// ═══════════════════════════════════════════════════════════════════════════
// GET  /api/driver/offer — the driver's current live offer (server-truth).
//   The offer is push-delivered for immediacy, but push alone is best-effort:
//   this endpoint lets the app RESTORE the active offer after a cold start,
//   reconnect, or missed push, and is polled as a fallback while online.
//   Expired offers are never returned — expiry is the server's clock.
// POST /api/driver/offer — client observability acks (displayed, sound
//   started/stopped, push received). Events land in ride_events so the whole
//   alert lifecycle is traceable per ride without logging tokens or PII.
// ═══════════════════════════════════════════════════════════════════════════

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

    const offer = await getActiveOfferForDriver(driver.id);
    if (!offer) return NextResponse.json({ offer: null });

    const { data: ride } = await svc
      .from('rides')
      .select('id, status, pickup_address, dropoff_address, pickup_lat, pickup_lng, estimated_fare, distance_km, duration_min, preferences')
      .eq('id', offer.rideId)
      .maybeSingle();

    // Offer key outlived the ride's searching state (accept/cancel raced the
    // TTL) — never surface it.
    if (!ride || ride.status !== 'searching_driver') {
      return NextResponse.json({ offer: null });
    }

    // Driver's live distance to the pickup, when we have a fresh fix.
    let pickupDistanceM: number | null = null;
    const { data: loc } = await svc
      .from('driver_locations')
      .select('location, updated_at')
      .eq('driver_id', driver.id)
      .maybeSingle();
    const point = loc ? parseGeoPoint(loc.location) : null;
    if (point) {
      pickupDistanceM = Math.round(
        haversineMeters(point, { lat: Number(ride.pickup_lat), lng: Number(ride.pickup_lng) }),
      );
    }

    const estimatedFare = Number(ride.estimated_fare);
    const preferences = (ride.preferences ?? {}) as { pet_friendly?: boolean };

    return NextResponse.json({
      offer: {
        rideId: ride.id,
        expiresAt: offer.expiresAt,
        pickupAddress: ride.pickup_address,
        dropoffAddress: ride.dropoff_address,
        pickupLat: Number(ride.pickup_lat),
        pickupLng: Number(ride.pickup_lng),
        estimatedFare,
        estimatedEarnings: driverShare(estimatedFare),
        distanceKm: Number(ride.distance_km),
        durationMin: ride.duration_min == null ? null : Number(ride.duration_min),
        pickupDistanceM,
        petFriendly: preferences.pet_friendly === true,
      },
    });
  } catch (err) {
    console.error('GET /api/driver/offer failed:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}

const ackSchema = z.object({
  rideId: z.string().uuid(),
  event: z.enum([
    'offer_push_received',
    'offer_displayed',
    'alert_sound_started',
    'alert_sound_stopped',
    'offer_expired_client',
  ]),
});

export async function POST(request: NextRequest) {
  try {
    const { user } = await createApiClient(request);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = ackSchema.parse(await request.json());

    const svc = createServiceClient();
    const { data: driver } = await svc
      .from('drivers')
      .select('id')
      .eq('auth_user_id', user.id)
      .maybeSingle();
    if (!driver) return NextResponse.json({ error: 'Not a driver' }, { status: 404 });

    const { error: insertError } = await svc.from('ride_events').insert({
      ride_id: body.rideId,
      event_type: body.event,
      actor: 'driver',
      metadata: { driver_id: driver.id },
    });
    if (insertError) {
      // Unknown ride id (FK) or similar — acks are best-effort telemetry.
      return NextResponse.json({ ok: false }, { status: 400 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }
    console.error('POST /api/driver/offer failed:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
