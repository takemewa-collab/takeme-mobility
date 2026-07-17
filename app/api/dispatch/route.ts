import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { dispatchRide } from '@/lib/dispatch-queue';

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/dispatch
// (Re)trigger the OFFER pipeline for a ride that is still searching.
// This never assigns a driver directly — it sends an offer that the driver
// must explicitly accept via the driver app.
// ═══════════════════════════════════════════════════════════════════════════

const requestSchema = z.object({
  rideId: z.string().uuid(),
});

export async function POST(request: NextRequest) {
  try {
    // 1. Authenticate (rider must own the ride)
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = requestSchema.parse(await request.json());

    // 2. Verify ride ownership
    const { data: ride } = await supabase
      .from('rides')
      .select('id, rider_id, status')
      .eq('id', body.rideId)
      .single();

    if (!ride || ride.rider_id !== user.id) {
      return NextResponse.json({ error: 'Ride not found' }, { status: 404 });
    }

    if (ride.status !== 'searching_driver') {
      return NextResponse.json({
        error: `Ride is ${ride.status}, not searching for a driver`,
      }, { status: 400 });
    }

    // 3. Run one offer cycle. Assignment happens only when a driver accepts.
    const result = await dispatchRide(body.rideId, 0);

    return NextResponse.json({
      assigned: false,
      offered: result.action === 'offered',
      action: result.action,
      error: result.error,
    });
  } catch (err) {
    console.error('POST /api/dispatch failed:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
