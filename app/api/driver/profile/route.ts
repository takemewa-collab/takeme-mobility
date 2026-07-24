import { NextRequest, NextResponse } from 'next/server';
import { createApiClient } from '@/lib/supabase/api';
import { createServiceClient } from '@/lib/supabase/service';

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/driver/profile — the Account screen's aggregate: driver identity
// (name, rating, verified state, driver id, member-since), the active
// vehicle, and document/compliance state with expirations. Contact info
// (phone/email/photo) comes from Clerk on the client — it is identity data
// the server does not own.
// ═══════════════════════════════════════════════════════════════════════════

export async function GET(request: NextRequest) {
  try {
    const { user } = await createApiClient(request);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const svc = createServiceClient();

    const { data: driver } = await svc
      .from('drivers')
      .select('id, full_name, rating, total_trips, status, is_verified, is_active, created_at')
      .eq('auth_user_id', user.id)
      .maybeSingle();
    if (!driver) return NextResponse.json({ error: 'Not a driver' }, { status: 404 });

    const [{ data: vehicle }, { data: documents }, { data: requirements }] = await Promise.all([
      svc
        .from('vehicles')
        .select('id, make, model, year, color, plate_number, vehicle_class, capacity')
        .eq('driver_id', driver.id)
        .eq('is_active', true)
        .maybeSingle(),
      svc
        .from('driver_documents')
        .select('id, doc_type, status, expires_at, reviewed_at, created_at')
        .eq('driver_id', user.id)
        .order('created_at', { ascending: false }),
      svc
        .from('application_requirements')
        .select('requirement_key, status, expires_at')
        .eq('user_id', user.id),
    ]);

    const now = Date.now();
    const soon = now + 30 * 24 * 3600 * 1000;
    const docs = (documents ?? []).map((d) => {
      const exp = d.expires_at ? new Date(d.expires_at as string).getTime() : null;
      return {
        id: d.id,
        docType: d.doc_type,
        status: d.status,
        expiresAt: d.expires_at,
        actionRequired:
          d.status === 'rejected' || (exp != null && exp < soon) || (exp != null && exp < now),
        expired: exp != null && exp < now,
      };
    });

    return NextResponse.json({
      driver: {
        // Short display id — enough for support without exposing raw UUIDs
        // in screenshots.
        driverId: (driver.id as string).slice(0, 8).toUpperCase(),
        fullName: driver.full_name,
        rating: driver.rating != null ? Number(driver.rating) : null,
        totalTrips: Number(driver.total_trips ?? 0),
        verified: driver.is_verified === true && driver.is_active === true,
        memberSince: driver.created_at,
      },
      vehicle: vehicle
        ? {
            make: vehicle.make,
            model: vehicle.model,
            year: vehicle.year,
            color: vehicle.color,
            plateNumber: vehicle.plate_number,
            vehicleClass: vehicle.vehicle_class,
            capacity: vehicle.capacity,
          }
        : null,
      documents: docs,
      requirements: (requirements ?? []).map((r) => ({
        key: r.requirement_key,
        status: r.status,
        expiresAt: r.expires_at,
      })),
    });
  } catch (err) {
    console.error('GET /api/driver/profile failed:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
