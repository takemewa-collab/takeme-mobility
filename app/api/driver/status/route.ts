import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getRequestUser } from '@/lib/auth/request-user';
import { createServiceClient } from '@/lib/supabase/service';

// ═══════════════════════════════════════════════════════════════════════════
// PUT /api/driver/status
// Toggle driver online (available) / offline.
// ═══════════════════════════════════════════════════════════════════════════

const requestSchema = z.object({
  status: z.enum(['available', 'offline']),
});

export async function PUT(request: NextRequest) {
  try {
    // 1. Authenticate (web cookie session or mobile Bearer token)
    const user = await getRequestUser(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 2. Parse
    const body = requestSchema.parse(await request.json());

    // 3. Find driver record for this auth user
    const svc = createServiceClient();
    const { data: driver, error: driverError } = await svc
      .from('drivers')
      .select('id, status')
      .eq('auth_user_id', user.id)
      .single();

    if (driverError || !driver) {
      return NextResponse.json({ error: 'Driver profile not found' }, { status: 404 });
    }

    // Don't allow going available if currently on_trip
    if (driver.status === 'on_trip' && body.status === 'available') {
      return NextResponse.json({ error: 'Complete your current trip first' }, { status: 400 });
    }

    // 4. Update status
    const { error: updateError } = await svc
      .from('drivers')
      .update({ status: body.status })
      .eq('id', driver.id);

    if (updateError) {
      return NextResponse.json({ error: 'Failed to update status' }, { status: 500 });
    }

    return NextResponse.json({ status: body.status, driverId: driver.id });
  } catch (err) {
    console.error('PUT /api/driver/status failed:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}

// GET current status
export async function GET(request: NextRequest) {
  try {
    const user = await getRequestUser(request);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const svc = createServiceClient();
    const { data: driver } = await svc
      .from('drivers')
      .select('id, status, full_name, rating, total_trips')
      .eq('auth_user_id', user.id)
      .single();

    if (!driver) return NextResponse.json({ error: 'Not a driver' }, { status: 404 });

    return NextResponse.json({ driver });
  } catch {
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
