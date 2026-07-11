import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createApiClient } from '@/lib/supabase/api';
import { createServiceClient } from '@/lib/supabase/service';
import { cancelPaymentIntent } from '@/lib/stripe';

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/rides/cancel
// Rider cancels their ride. Only allowed before in_progress.
// ═══════════════════════════════════════════════════════════════════════════

const RIDER_CANCELLABLE: string[] = [
  'pending',
  'quoted',
  'searching_driver',
  'driver_assigned',
  'driver_arriving',
  'arrived',
];

const requestSchema = z.object({
  rideId: z.string().uuid(),
  reason: z.string().max(500).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const { supabase, user } = await createApiClient(request);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = requestSchema.parse(await request.json());

    // Fetch ride — rider owns it
    const { data: ride } = await supabase
      .from('rides')
      .select('id, status, assigned_driver_id, rider_id')
      .eq('id', body.rideId)
      .single();

    if (!ride || ride.rider_id !== user.id) {
      return NextResponse.json({ error: 'Ride not found' }, { status: 404 });
    }

    if (!RIDER_CANCELLABLE.includes(ride.status)) {
      return NextResponse.json({
        error: ride.status === 'in_progress'
          ? 'Cannot cancel a ride in progress. Contact support.'
          : 'This ride cannot be cancelled.',
      }, { status: 400 });
    }

    const svc = createServiceClient();
    const now = new Date().toISOString();

    // Cancel ride with optimistic lock
    const { data: updated, error: updateError } = await svc
      .from('rides')
      .update({
        status: 'cancelled',
        cancelled_at: now,
        cancelled_by: 'rider',
        cancel_reason: body.reason ?? 'Cancelled by rider',
      })
      .eq('id', body.rideId)
      .eq('status', ride.status)
      .select('id')
      .maybeSingle();

    if (updateError) {
      return NextResponse.json({ error: 'Cancellation failed' }, { status: 500 });
    }

    if (!updated) {
      return NextResponse.json({ error: 'Ride status changed — please refresh' }, { status: 409 });
    }

    // Release the driver if one was assigned
    if (ride.assigned_driver_id) {
      await svc
        .from('drivers')
        .update({ status: 'available' })
        .eq('id', ride.assigned_driver_id)
        .in('status', ['busy', 'on_trip']);
    }

    // Cancel the PaymentIntent if one exists
    const { data: payment } = await svc
      .from('payments')
      .select('stripe_payment_intent, status')
      .eq('ride_id', body.rideId)
      .in('status', ['pending', 'authorized'])
      .maybeSingle();

    if (payment?.stripe_payment_intent) {
      try {
        await cancelPaymentIntent(payment.stripe_payment_intent, 'requested_by_customer');
        await svc.from('payments').update({ status: 'failed', failure_reason: 'Ride cancelled' }).eq('stripe_payment_intent', payment.stripe_payment_intent);
      } catch (stripeErr) {
        console.warn('PaymentIntent cancel failed (non-fatal):', stripeErr);
      }
    }

    // Log event
    await svc.from('ride_events').insert({
      ride_id: body.rideId,
      event_type: 'status_change',
      old_status: ride.status,
      new_status: 'cancelled',
      actor: 'rider',
      metadata: { reason: body.reason ?? 'Cancelled by rider' },
    });

    return NextResponse.json({ cancelled: true, rideId: body.rideId });
  } catch (err) {
    console.error('POST /api/rides/cancel failed:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
