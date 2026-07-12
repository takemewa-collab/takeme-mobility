import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { getDriverOffer, clearDriverOffer } from '@/lib/redis';
import { finalizeAssignment } from '@/lib/dispatch';
import { assessTripFraud } from '@/lib/fraud';
import { capturePaymentIntent, cancelPaymentIntent } from '@/lib/stripe';

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/driver/rides      — get assigned ride for current driver
// PUT /api/driver/rides      — update ride status (accept, arrive, start, complete)
// ═══════════════════════════════════════════════════════════════════════════

// ── GET: current assigned ride ──────────────────────────────────────────

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const svc = createServiceClient();
    const { data: driver } = await svc
      .from('drivers')
      .select('id')
      .eq('auth_user_id', user.id)
      .single();

    if (!driver) return NextResponse.json({ error: 'Not a driver' }, { status: 404 });

    // Find active ride assigned to this driver
    const { data: ride } = await svc
      .from('rides')
      .select(`
        id, status, rider_id,
        pickup_address, pickup_lat, pickup_lng,
        dropoff_address, dropoff_lat, dropoff_lng,
        vehicle_class, distance_km, duration_min,
        estimated_fare, currency,
        requested_at, driver_assigned_at
      `)
      .eq('assigned_driver_id', driver.id)
      .not('status', 'in', '("completed","cancelled")')
      .order('driver_assigned_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!ride) {
      return NextResponse.json({ ride: null });
    }

    // Fetch rider info
    const { data: rider } = await svc
      .from('riders')
      .select('full_name, rating')
      .eq('id', ride.rider_id)
      .single();

    return NextResponse.json({
      ride: {
        ...ride,
        rider_name: rider?.full_name ?? 'Rider',
        rider_rating: rider?.rating ?? 5.0,
      },
    });
  } catch (err) {
    console.error('GET /api/driver/rides failed:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}

// ── PUT: update ride status ─────────────────────────────────────────────

const VALID_TRANSITIONS: Record<string, string[]> = {
  driver_assigned:  ['driver_arriving', 'cancelled'],
  driver_arriving:  ['arrived', 'cancelled'],
  arrived:          ['in_progress', 'cancelled'],
  in_progress:      ['completed', 'cancelled'],
};

const updateSchema = z.object({
  rideId: z.string().uuid(),
  action: z.enum(['accept', 'arriving', 'arrived', 'start_trip', 'complete', 'cancel']),
  cancelReason: z.string().optional(),
});

const ACTION_TO_STATUS: Record<string, string> = {
  accept: 'driver_arriving',
  arriving: 'driver_arriving',
  arrived: 'arrived',
  start_trip: 'in_progress',
  complete: 'completed',
  cancel: 'cancelled',
};

export async function PUT(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = updateSchema.parse(await request.json());

    const svc = createServiceClient();

    // Resolve driver
    const { data: driver } = await svc
      .from('drivers')
      .select('id')
      .eq('auth_user_id', user.id)
      .single();

    if (!driver) return NextResponse.json({ error: 'Not a driver' }, { status: 404 });

    // Fetch ride
    const { data: ride } = await svc
      .from('rides')
      .select('id, status, assigned_driver_id')
      .eq('id', body.rideId)
      .single();

    if (!ride) return NextResponse.json({ error: 'Ride not found' }, { status: 404 });

    // ── Special handling for ACCEPT (offer-based flow) ───────────────
    if (body.action === 'accept' && ride.status === 'searching_driver') {
      // Verify this driver has an active offer for this ride
      const offeredDriverId = await getDriverOffer(body.rideId);
      if (offeredDriverId && offeredDriverId !== driver.id) {
        return NextResponse.json({ error: 'This ride was offered to another driver' }, { status: 403 });
      }

      // Finalize the assignment (clears Redis offer, updates ride + driver status)
      const result = await finalizeAssignment(body.rideId, driver.id);
      if (!result.success) {
        return NextResponse.json({ error: result.error ?? 'Accept failed' }, { status: 400 });
      }

      return NextResponse.json({ status: 'driver_assigned', rideId: body.rideId, driver: result.driver });
    }

    // For non-accept actions, verify the driver owns the ride
    if (ride.assigned_driver_id !== driver.id) {
      return NextResponse.json({ error: 'Not your ride' }, { status: 403 });
    }

    // Validate transition
    const newStatus = ACTION_TO_STATUS[body.action];
    const allowed = VALID_TRANSITIONS[ride.status];
    if (!allowed || !allowed.includes(newStatus)) {
      return NextResponse.json({
        error: `Cannot transition from ${ride.status} to ${newStatus}`,
      }, { status: 400 });
    }

    // Build update
    const now = new Date().toISOString();
    const update: Record<string, unknown> = { status: newStatus };

    switch (newStatus) {
      case 'driver_arriving':
        // no extra fields
        break;
      case 'arrived':
        update.driver_arrived_at = now;
        break;
      case 'in_progress':
        update.trip_started_at = now;
        break;
      case 'completed': {
        update.trip_completed_at = now;
        update.final_fare = null; // set by payment capture

        // Run fraud assessment on trip completion
        try {
          const { data: fullRide } = await svc.from('rides')
            .select('rider_id, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, distance_km, duration_min, estimated_fare')
            .eq('id', body.rideId).single();

          if (fullRide) {
            const fraud = await assessTripFraud({
              rideId: body.rideId,
              riderId: fullRide.rider_id,
              driverId: driver.id,
              pickupLat: Number(fullRide.pickup_lat),
              pickupLng: Number(fullRide.pickup_lng),
              dropoffLat: Number(fullRide.dropoff_lat),
              dropoffLng: Number(fullRide.dropoff_lng),
              distanceKm: Number(fullRide.distance_km ?? 0),
              durationMin: Number(fullRide.duration_min ?? 0),
            });

            if (fraud.action === 'cancel') {
              // Auto-cancel fraudulent trip
              update.status = 'cancelled';
              update.cancel_reason = `Fraud detected (score ${fraud.totalScore}): ${fraud.reasons.join(', ')}`;
              update.cancelled_by = 'system';
            }
          }
        } catch (fraudErr) {
          console.error('[fraud] Assessment failed (non-blocking):', fraudErr);
        }
        break;
      }
      case 'cancelled':
        update.cancelled_at = now;
        update.cancelled_by = 'driver';
        update.cancel_reason = body.cancelReason ?? 'Driver cancelled';
        break;
    }

    const { data: updated, error: updateError } = await svc
      .from('rides')
      .update(update)
      .eq('id', body.rideId)
      .eq('status', ride.status)  // optimistic lock — prevent race
      .select('id')
      .maybeSingle();

    if (updateError) {
      return NextResponse.json({ error: 'Update failed' }, { status: 500 });
    }

    if (!updated) {
      return NextResponse.json({ error: 'Ride status changed — please refresh' }, { status: 409 });
    }

    // The persisted status can differ from newStatus (fraud flips complete →
    // cancelled), so settle payment off what was actually written.
    const finalStatus = (update.status as string) ?? newStatus;

    // Update driver status
    if (finalStatus === 'in_progress') {
      await svc.from('drivers').update({ status: 'on_trip' }).eq('id', driver.id);
    } else if (finalStatus === 'completed' || finalStatus === 'cancelled') {
      await svc.from('drivers').update({ status: 'available' }).eq('id', driver.id);
    }

    // Settle the authorized card hold. Non-blocking: a Stripe hiccup must not
    // strand the ride in a wrong state — the webhook and reconciliation can
    // still finish it — but the common path resolves here.
    if (finalStatus === 'completed' || finalStatus === 'cancelled') {
      try {
        const { data: pay } = await svc
          .from('payments')
          .select('stripe_payment_intent, amount, status')
          .eq('ride_id', body.rideId)
          .maybeSingle();

        if (pay?.stripe_payment_intent && pay.status !== 'captured' && pay.status !== 'cancelled') {
          if (finalStatus === 'completed') {
            const captured = await capturePaymentIntent(pay.stripe_payment_intent);
            await svc.from('payments')
              .update({ status: 'captured' })
              .eq('ride_id', body.rideId);
            // The captured amount is the fare the rider actually pays.
            await svc.from('rides')
              .update({ final_fare: pay.amount })
              .eq('id', body.rideId);
            console.log('[driver/rides] captured', captured.id, 'for ride', body.rideId);
          } else {
            await cancelPaymentIntent(pay.stripe_payment_intent, 'abandoned');
            await svc.from('payments')
              .update({ status: 'cancelled' })
              .eq('ride_id', body.rideId);
            console.log('[driver/rides] released hold for cancelled ride', body.rideId);
          }
        }
      } catch (payErr) {
        console.error('[driver/rides] payment settlement failed (non-blocking):', payErr);
      }
    }

    // Log event
    await svc.from('ride_events').insert({
      ride_id: body.rideId,
      event_type: 'status_change',
      old_status: ride.status,
      new_status: newStatus,
      actor: 'driver',
      metadata: { driver_id: driver.id, action: body.action },
    });

    return NextResponse.json({ status: newStatus, rideId: body.rideId });
  } catch (err) {
    console.error('PUT /api/driver/rides failed:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
