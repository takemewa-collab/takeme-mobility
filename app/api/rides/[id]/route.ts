import { NextRequest, NextResponse } from 'next/server';
import { createApiClient } from '@/lib/supabase/api';
import { createServiceClient } from '@/lib/supabase/service';
import { parseGeoPoint } from '@/lib/trip-geofence';

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/rides/[id] — rider-owned single-ride snapshot.
//
// The rider app's authoritative polling/rehydration source: whatever realtime
// does, this endpoint always returns the server truth for the ride the rider
// booked, plus the assigned driver's public card data and latest position.
// The trip status shown in the UI must derive from this record.
// ═══════════════════════════════════════════════════════════════════════════

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { user } = await createApiClient(request);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const { id } = await params;

    const svc = createServiceClient();
    const { data: ride } = await svc
      .from('rides')
      .select('*')
      .eq('id', id)
      .eq('rider_id', user.id)
      .maybeSingle();
    if (!ride) return NextResponse.json({ error: 'Ride not found' }, { status: 404 });

    let driver: Record<string, unknown> | null = null;
    let driverLocation: { lat: number; lng: number; heading: number | null; updatedAt: string } | null =
      null;
    if (ride.assigned_driver_id) {
      const [{ data: driverRow }, { data: vehicle }, { data: fixRow }] = await Promise.all([
        svc
          .from('drivers')
          .select('id, full_name, rating, avatar_url')
          .eq('id', ride.assigned_driver_id)
          .maybeSingle(),
        svc
          .from('vehicles')
          .select('make, model, year, color, plate_number, vehicle_class')
          .eq('driver_id', ride.assigned_driver_id)
          .eq('is_active', true)
          .limit(1)
          .maybeSingle(),
        svc
          .from('driver_locations')
          .select('location, heading, updated_at')
          .eq('driver_id', ride.assigned_driver_id)
          .maybeSingle(),
      ]);
      if (driverRow) driver = { ...driverRow, vehicle: vehicle ?? null };
      const point = parseGeoPoint(fixRow?.location ?? null);
      if (fixRow && point) {
        driverLocation = {
          ...point,
          heading: fixRow.heading == null ? null : Number(fixRow.heading),
          updatedAt: fixRow.updated_at as string,
        };
      }
    }

    return NextResponse.json({ ride, driver, driverLocation });
  } catch (err) {
    console.error('GET /api/rides/[id] failed:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
