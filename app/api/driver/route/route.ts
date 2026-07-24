import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createApiClient } from '@/lib/supabase/api';
import { createServiceClient } from '@/lib/supabase/service';
import { calculateRoute } from '@/lib/route-service';
import { rateLimit } from '@/lib/rate-limit';
import { parseGeoPoint } from '@/lib/trip-geofence';

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/driver/route?toLat=..&toLng=..[&fromLat=..&fromLng=..]
//
// Real driving route for the driver's live navigation surfaces: ETA,
// remaining distance, and the encoded polyline from the driver's position
// (given, or their latest server-known fix) to the target — the pickup while
// en route, the destination during the trip. Never a straight-line guess.
// ═══════════════════════════════════════════════════════════════════════════

const querySchema = z.object({
  toLat: z.coerce.number().min(-90).max(90),
  toLng: z.coerce.number().min(-180).max(180),
  fromLat: z.coerce.number().min(-90).max(90).optional(),
  fromLng: z.coerce.number().min(-180).max(180).optional(),
});

export async function GET(request: NextRequest) {
  try {
    const rateLimited = await rateLimit(request, 'driver-route');
    if (rateLimited) return rateLimited;

    const { user } = await createApiClient(request);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid coordinates' }, { status: 400 });
    }
    const q = parsed.data;

    const svc = createServiceClient();
    const { data: driver } = await svc
      .from('drivers')
      .select('id')
      .eq('auth_user_id', user.id)
      .single();
    if (!driver) return NextResponse.json({ error: 'Not a driver' }, { status: 404 });

    let from: { lat: number; lng: number } | null =
      q.fromLat != null && q.fromLng != null ? { lat: q.fromLat, lng: q.fromLng } : null;

    if (!from) {
      const { data: fixRow } = await svc
        .from('driver_locations')
        .select('location')
        .eq('driver_id', driver.id)
        .maybeSingle();
      from = parseGeoPoint(fixRow?.location ?? null);
    }
    if (!from) {
      return NextResponse.json(
        { error: 'No known driver location — send a location update first.' },
        { status: 409 },
      );
    }

    const route = await calculateRoute({
      pickupLat: from.lat,
      pickupLng: from.lng,
      dropoffLat: q.toLat,
      dropoffLng: q.toLng,
    });

    return NextResponse.json({
      distanceKm: route.distanceKm,
      // Never promise "0 min" — anything under a minute rounds up to 1.
      durationMin: Math.max(1, Math.round(route.durationMin)),
      polyline: route.polyline,
      from,
    });
  } catch (err) {
    console.error('GET /api/driver/route failed:', err);
    return NextResponse.json({ error: 'Routing failed' }, { status: 500 });
  }
}
