import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createApiClient } from '@/lib/supabase/api';
import { createServiceClient } from '@/lib/supabase/service';
import { cacheDriverLocation } from '@/lib/redis';
import { publishDriverLocation } from '@/lib/ably';
import { rateLimit } from '@/lib/rate-limit';

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/driver/location
// Update driver GPS position. Called frequently from driver app.
// ═══════════════════════════════════════════════════════════════════════════

const requestSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  heading: z.number().min(0).max(360).optional(),
  speedKmh: z.number().min(0).optional(),
});

export async function POST(request: NextRequest) {
  try {
    // 0. Rate limit
    const rateLimited = await rateLimit(request, 'driver-location');
    if (rateLimited) return rateLimited;

    // 1. Authenticate
    const { supabase, user } = await createApiClient(request);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    // 2. Parse
    const body = requestSchema.parse(await request.json());

    // 3. Resolve driver ID
    const svc = createServiceClient();
    const { data: driver } = await svc
      .from('drivers')
      .select('id, status')
      .eq('auth_user_id', user.id)
      .single();

    if (!driver) return NextResponse.json({ error: 'Not a driver' }, { status: 404 });

    // Only update location if driver is online
    if (driver.status === 'offline') {
      return NextResponse.json({ error: 'Go online first' }, { status: 400 });
    }

    // 4. Upsert location via RPC
    const { error } = await svc.rpc('upsert_driver_location', {
      p_driver_id: driver.id,
      p_lat: body.lat,
      p_lng: body.lng,
      p_heading: body.heading ?? null,
      p_speed_kmh: body.speedKmh ?? null,
    });

    if (error) {
      console.error('Location upsert failed:', error.message);
      return NextResponse.json({ error: 'Location update failed' }, { status: 500 });
    }

    // 5. Cache in Redis for fast dispatch lookups
    try {
      await cacheDriverLocation({
        driverId: driver.id,
        lat: body.lat,
        lng: body.lng,
        heading: body.heading ?? null,
        speedKmh: body.speedKmh ?? null,
        vehicleClass: 'economy', // will be enriched by dispatch
        updatedAt: Date.now(),
      });
    } catch { /* Redis cache is enhancement, not critical */ }

    // 6. Publish to Ably for real-time rider tracking (<200ms)
    try {
      await publishDriverLocation({
        driverId: driver.id,
        lat: body.lat,
        lng: body.lng,
        heading: body.heading ?? null,
        speedKmh: body.speedKmh ?? null,
        timestamp: Date.now(),
      });
    } catch { /* Ably is enhancement, not critical */ }

    return NextResponse.json({ updated: true });
  } catch (err) {
    console.error('POST /api/driver/location failed:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
