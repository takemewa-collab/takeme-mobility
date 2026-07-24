import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createApiClient } from '@/lib/supabase/api';
import { createServiceClient } from '@/lib/supabase/service';
import { getDriverOffer, clearDriverOffer, markOfferDeclined, addExcludedDriver } from '@/lib/redis';
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
    const { supabase, user } = await createApiClient(request);
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
        estimated_fare, currency, preferences,
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

    // Ordered itinerary. Empty for classic single-destination rides — the
    // driver app then falls back to the flat pickup/dropoff columns.
    const { data: routePoints } = await svc
      .from('ride_route_points')
      .select(
        'id, point_type, seq, place_name, formatted_address, lat, lng, leg_distance_km, leg_duration_min, status, arrived_at, completed_at',
      )
      .eq('ride_id', ride.id)
      .order('seq', { ascending: true });

    // Airport context snapshots (immutable, booked-time truth). Empty for
    // non-airport trips — the driver app renders curb instructions from these.
    const { data: airportContexts } = await svc
      .from('trip_airport_context')
      .select('id, direction, route_point_id, flight_number, selection_method, snapshot')
      .eq('ride_id', ride.id);

    // Preference projection: the driver sees the two booleans only — never
    // the fallback strategy or any other rider-side detail.
    const prefs = (ride.preferences ?? {}) as { pet_friendly?: boolean; women_preferred?: boolean };

    return NextResponse.json({
      ride: {
        ...ride,
        preferences: {
          pet_friendly: prefs.pet_friendly === true,
          women_preferred: prefs.women_preferred === true,
        },
        rider_name: rider?.full_name ?? 'Rider',
        rider_rating: rider?.rating ?? 5.0,
        route_points: routePoints ?? [],
        airport_contexts: airportContexts ?? [],
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
  action: z.enum([
    'accept',
    'decline',
    'arriving',
    'arrived',
    'start_trip',
    'complete',
    'cancel',
    // Multi-stop itinerary progression — operate on one intermediate stop
    // while the ride itself stays `in_progress`.
    'arrive_stop',
    'depart_stop',
    'skip_stop',
  ]),
  cancelReason: z.string().optional(),
  /** Required for the *_stop actions: the ride_route_points row to advance. */
  pointId: z.string().uuid().optional(),
});

const STOP_ACTIONS = new Set(['arrive_stop', 'depart_stop', 'skip_stop']);

const STOP_TARGET: Record<string, 'arrived' | 'completed' | 'skipped'> = {
  arrive_stop: 'arrived',
  depart_stop: 'completed',
  skip_stop: 'skipped',
};

const STOP_FROM: Record<string, string[]> = {
  arrive_stop: ['pending'],
  depart_stop: ['arrived'],
  skip_stop: ['pending', 'arrived'],
};

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
    const { supabase, user } = await createApiClient(request);
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

    // ── Special handling for DECLINE (offer-based flow) ──────────────
    // The driver turns down an offer they hold. The ride is still
    // `searching_driver`, so this must NOT cancel it: exclude this driver
    // from re-offers and flip the Redis offer to the declined sentinel. The
    // already-scheduled timeout callback sees a non-accepted offer at the
    // 15s mark and escalates to the next candidate as usual.
    if (body.action === 'decline') {
      if (ride.status !== 'searching_driver') {
        // Offer window is over (someone accepted or the ride moved on) —
        // declining is a harmless no-op for the caller.
        return NextResponse.json({ status: 'declined', rideId: body.rideId });
      }
      const offeredDriverId = await getDriverOffer(body.rideId);
      if (offeredDriverId && offeredDriverId !== driver.id && offeredDriverId !== 'declined') {
        return NextResponse.json({ error: 'This ride was offered to another driver' }, { status: 403 });
      }
      await addExcludedDriver(body.rideId, driver.id);
      await markOfferDeclined(body.rideId);
      await svc.from('ride_events').insert({
        ride_id: body.rideId,
        event_type: 'offer_declined',
        actor: 'driver',
        metadata: { driver_id: driver.id },
      });
      return NextResponse.json({ status: 'declined', rideId: body.rideId });
    }

    // For non-accept actions, verify the driver owns the ride
    if (ride.assigned_driver_id !== driver.id) {
      return NextResponse.json({ error: 'Not your ride' }, { status: 403 });
    }

    // ── Multi-stop itinerary progression ─────────────────────────────
    // These advance ONE intermediate stop; the ride status stays
    // `in_progress`. Idempotent: replaying an action whose target state is
    // already reached returns 200 with the current state instead of erroring,
    // so double-taps and retried requests cannot corrupt the trip.
    if (STOP_ACTIONS.has(body.action)) {
      if (ride.status !== 'in_progress') {
        return NextResponse.json(
          { error: 'Stops can only be updated during the trip.' },
          { status: 409 },
        );
      }
      if (!body.pointId) {
        return NextResponse.json({ error: 'pointId is required.' }, { status: 400 });
      }

      const { data: point } = await svc
        .from('ride_route_points')
        .select('id, point_type, seq, status')
        .eq('id', body.pointId)
        .eq('ride_id', body.rideId)
        .single();

      if (!point) {
        return NextResponse.json({ error: 'Route point not found.' }, { status: 404 });
      }
      if (point.point_type !== 'stop') {
        return NextResponse.json(
          { error: 'Only intermediate stops can be updated with this action.' },
          { status: 400 },
        );
      }

      const target = STOP_TARGET[body.action];

      // Replay of an already-applied (or terminally settled) action → success.
      if (point.status === target || point.status === 'completed' || point.status === 'skipped') {
        return NextResponse.json({ pointId: point.id, pointStatus: point.status, replay: true });
      }

      if (!STOP_FROM[body.action].includes(point.status)) {
        return NextResponse.json(
          { error: `Stop is ${point.status} — cannot ${body.action.replace('_', ' ')}.` },
          { status: 409 },
        );
      }

      // Order guard: arriving at a later stop while an earlier one is still
      // pending would silently skip it. Skipping is its own explicit action.
      if (body.action !== 'skip_stop') {
        const { data: earlierOpen } = await svc
          .from('ride_route_points')
          .select('id')
          .eq('ride_id', body.rideId)
          .eq('point_type', 'stop')
          .lt('seq', point.seq)
          .in('status', ['pending', 'arrived'])
          .limit(1);
        if (earlierOpen && earlierOpen.length > 0) {
          return NextResponse.json(
            { error: 'An earlier stop is still open — complete or skip it first.' },
            { status: 409 },
          );
        }
      }

      const nowIso = new Date().toISOString();
      const pointUpdate: Record<string, unknown> = { status: target };
      if (target === 'arrived') pointUpdate.arrived_at = nowIso;
      else pointUpdate.completed_at = nowIso;

      const { data: updatedPoint, error: pointError } = await svc
        .from('ride_route_points')
        .update(pointUpdate)
        .eq('id', point.id)
        .eq('status', point.status) // optimistic lock — concurrent taps race safely
        .select('id, status')
        .maybeSingle();

      if (pointError) {
        return NextResponse.json({ error: 'Update failed' }, { status: 500 });
      }
      if (!updatedPoint) {
        return NextResponse.json(
          { error: 'Stop state changed — please refresh.' },
          { status: 409 },
        );
      }

      await svc.from('ride_events').insert({
        ride_id: body.rideId,
        event_type: `route_point_${target}`,
        actor: 'driver',
        metadata: { driver_id: driver.id, point_id: point.id, seq: point.seq, action: body.action },
      });

      return NextResponse.json({ pointId: updatedPoint.id, pointStatus: updatedPoint.status });
    }

    // Completing the ride requires the whole itinerary to be settled — the
    // final destination is the only place a trip can end.
    if (body.action === 'complete') {
      const { data: openStops } = await svc
        .from('ride_route_points')
        .select('id')
        .eq('ride_id', body.rideId)
        .eq('point_type', 'stop')
        .in('status', ['pending', 'arrived'])
        .limit(1);
      if (openStops && openStops.length > 0) {
        return NextResponse.json(
          { error: 'Stops remain on the itinerary — continue the trip first.' },
          { status: 409 },
        );
      }
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

    // Mirror ride-level milestones onto the route points so multi-stop
    // itineraries stay consistent (single-destination rides have no rows here
    // and each update simply matches nothing). Best-effort — a miss never
    // strands the ride, and restore paths re-derive from ride.status.
    try {
      if (finalStatus === 'arrived') {
        await svc
          .from('ride_route_points')
          .update({ status: 'arrived', arrived_at: now })
          .eq('ride_id', body.rideId)
          .eq('point_type', 'pickup')
          .eq('status', 'pending');
      } else if (finalStatus === 'in_progress') {
        await svc
          .from('ride_route_points')
          .update({ status: 'completed', completed_at: now })
          .eq('ride_id', body.rideId)
          .eq('point_type', 'pickup')
          .neq('status', 'completed');
      } else if (finalStatus === 'completed') {
        await svc
          .from('ride_route_points')
          .update({ status: 'completed', arrived_at: now, completed_at: now })
          .eq('ride_id', body.rideId)
          .eq('point_type', 'dropoff')
          .neq('status', 'completed');
      }
    } catch (pointErr) {
      console.warn('[driver/rides] route-point mirror failed (non-blocking):', pointErr);
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
