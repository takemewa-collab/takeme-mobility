import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createApiClient } from '@/lib/supabase/api';
import { createServiceClient } from '@/lib/supabase/service';
import { findOrCreateCustomer, createPaymentIntent, attachRideToPaymentIntent } from '@/lib/stripe';
import { dispatchWithRetry } from '@/lib/dispatch-queue';
import { TIERS, calculateFare, type VehicleClass } from '@/lib/pricing';
import {
  haversineKm,
  routePointsArraySchema,
  routeTotalsPlausible,
  validateRoutePoints,
} from '@/lib/route-points';
import { calculateRoute } from '@/lib/route-service';
import { rateLimit } from '@/lib/rate-limit';

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/rides/create
//
// Creates a ride record for an authenticated rider.
// Accepts the selected quote data, validates it, persists to `rides` table,
// saves the quote snapshot to `ride_quotes`, and returns the ride ID.
// ═══════════════════════════════════════════════════════════════════════════

const vehicleClassSchema = z.enum(['economy', 'comfort', 'premium']);

const requestSchema = z.object({
  // Locations
  pickupAddress: z.string().min(1),
  pickupLat: z.number().min(-90).max(90),
  pickupLng: z.number().min(-180).max(180),
  dropoffAddress: z.string().min(1),
  dropoffLat: z.number().min(-90).max(90),
  dropoffLng: z.number().min(-180).max(180),

  // Route
  distanceKm: z.number().positive(),
  durationMin: z.number().int().positive(),
  polyline: z.string().optional(),

  // Selected tier
  vehicleClass: vehicleClassSchema,

  // Fare from quote
  baseFare: z.number().nonnegative(),
  distanceFare: z.number().nonnegative(),
  timeFare: z.number().nonnegative(),
  totalFare: z.number().positive(),
  surgeMultiplier: z.number().min(1).max(5).default(1.0),
  currency: z.string().length(3).default('USD'),

  // Mobile clients authorize the card via /api/mobile/payment-sheet BEFORE the
  // ride exists, then pass that intent here so we link it instead of creating a
  // second one. Absent → legacy path that creates its own intent.
  paymentIntentId: z.string().startsWith('pi_').optional(),

  // Multi-stop itinerary: pickup → up to 3 stops → dropoff, ordered by seq.
  // Absent → classic single-destination ride (fully backward compatible).
  routePoints: routePointsArraySchema.optional(),
});

export async function POST(request: NextRequest) {
  try {
    // 0. Rate limit
    const rateLimited = await rateLimit(request, 'rides-create');
    if (rateLimited) return rateLimited;

    // 1. Authenticate — cookie session (web) or bearer token (mobile apps).
    const { supabase, user } = await createApiClient(request);

    if (!user) {
      return NextResponse.json(
        { error: 'Sign in to book a ride.' },
        { status: 401 },
      );
    }

    // 2. Parse + validate
    let body: z.infer<typeof requestSchema>;
    try {
      const raw = await request.json();
      body = requestSchema.parse(raw);
    } catch (err) {
      const message = err instanceof z.ZodError
        ? err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
        : 'Invalid request body';
      return NextResponse.json({ error: message }, { status: 400 });
    }

    // 3. Multi-stop route validation (when an itinerary is submitted).
    // Semantics first (one pickup, one dropoff, ≤3 stops, contiguous order),
    // then endpoint agreement with the flat pickup/dropoff fields, then route
    // totals — verified against Google when reachable, with a straight-line
    // plausibility floor as the always-on guard.
    let orderedPoints: ReturnType<typeof validateRoutePoints>['ordered'] = undefined;
    let stopCount = 0;

    if (body.routePoints) {
      const route = validateRoutePoints(body.routePoints);
      if (!route.ok || !route.ordered) {
        return NextResponse.json({ error: route.error ?? 'Invalid route.' }, { status: 400 });
      }
      orderedPoints = route.ordered;
      stopCount = orderedPoints.length - 2;

      const first = orderedPoints[0];
      const last = orderedPoints[orderedPoints.length - 1];
      const ENDPOINT_TOLERANCE_KM = 0.05;
      if (
        haversineKm(first, { lat: body.pickupLat, lng: body.pickupLng }) > ENDPOINT_TOLERANCE_KM ||
        haversineKm(last, { lat: body.dropoffLat, lng: body.dropoffLng }) > ENDPOINT_TOLERANCE_KM
      ) {
        return NextResponse.json(
          { error: 'Route points do not match the pickup and destination.' },
          { status: 400 },
        );
      }

      if (!routeTotalsPlausible(orderedPoints, body.distanceKm)) {
        return NextResponse.json(
          { error: 'Route totals look wrong — please refresh your quote.' },
          { status: 400 },
        );
      }

      // Independent recalculation through every waypoint. Provider hiccups
      // must not block booking (the plausibility guard above still holds),
      // but when Google answers, a big disagreement is a stale/forged quote.
      try {
        const serverRoute = await calculateRoute({
          pickupLat: body.pickupLat,
          pickupLng: body.pickupLng,
          dropoffLat: body.dropoffLat,
          dropoffLng: body.dropoffLng,
          waypoints: orderedPoints.slice(1, -1).map((p) => ({ lat: p.lat, lng: p.lng })),
        });
        const kmDrift = Math.abs(serverRoute.distanceKm - body.distanceKm);
        if (kmDrift > Math.max(3, serverRoute.distanceKm * 0.25)) {
          return NextResponse.json(
            { error: 'Route changed since your quote — please refresh.' },
            { status: 400 },
          );
        }
      } catch (routeErr) {
        console.warn('Server route verification unavailable (non-fatal):', routeErr);
      }
    }

    // 4. Server-side fare verification — prevent client-side price manipulation
    const tier = TIERS[body.vehicleClass as VehicleClass];
    if (!tier) {
      return NextResponse.json({ error: 'Invalid vehicle class' }, { status: 400 });
    }

    const serverFare = calculateFare(tier, body.distanceKm, body.durationMin, {
      surgeMultiplier: body.surgeMultiplier,
      currency: body.currency,
      stopCount,
    });

    // Allow $1.00 tolerance for floating-point rounding differences
    if (Math.abs(serverFare.total - body.totalFare) > 1.0) {
      return NextResponse.json({
        error: 'Fare mismatch — please refresh your quote.',
      }, { status: 400 });
    }

    // Use server-calculated fare as the source of truth
    const verifiedFare = serverFare.total;

    // Cap maximum fare as a sanity check
    if (verifiedFare > 500) {
      return NextResponse.json({ error: 'Fare exceeds maximum allowed.' }, { status: 400 });
    }

    // 4. Save quote snapshot (immutable record of the price the rider saw)
    const quoteExpiry = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    const { data: quoteData, error: quoteError } = await supabase
      .from('ride_quotes')
      .insert({
        rider_id: user.id,
        pickup_address: body.pickupAddress,
        pickup_lat: body.pickupLat,
        pickup_lng: body.pickupLng,
        dropoff_address: body.dropoffAddress,
        dropoff_lat: body.dropoffLat,
        dropoff_lng: body.dropoffLng,
        distance_km: body.distanceKm,
        duration_min: body.durationMin,
        route_polyline: body.polyline ?? null,
        vehicle_class: body.vehicleClass,
        base_fare: body.baseFare,
        distance_fare: body.distanceFare,
        time_fare: body.timeFare,
        surge_multiplier: body.surgeMultiplier,
        total_fare: verifiedFare,
        currency: body.currency,
        expires_at: quoteExpiry,
      })
      .select('id')
      .single();

    // Quote persistence is non-fatal — ride can still be created
    const quoteId = quoteError ? null : quoteData?.id;
    if (quoteError) {
      console.warn('Quote snapshot failed (non-fatal):', quoteError.message);
    }

    // 5. Create ride record
    type CreatedRide = {
      id: string;
      status: string;
      estimated_fare: number;
      currency: string;
      requested_at: string;
    };
    let rideData: CreatedRide | null = null;

    if (orderedPoints) {
      // Multi-stop: the ride row and its ordered points must land atomically —
      // a SECURITY DEFINER function (042) does both in one transaction. It is
      // executable by the service role only; the rider was authenticated above.
      const svc = createServiceClient();
      const { data: created, error: rpcError } = await svc.rpc('create_ride_with_route_points', {
        p_rider_id: user.id,
        p_ride: {
          quote_id: quoteId,
          pickup_address: body.pickupAddress,
          pickup_lat: body.pickupLat,
          pickup_lng: body.pickupLng,
          dropoff_address: body.dropoffAddress,
          dropoff_lat: body.dropoffLat,
          dropoff_lng: body.dropoffLng,
          vehicle_class: body.vehicleClass,
          distance_km: body.distanceKm,
          duration_min: body.durationMin,
          route_polyline: body.polyline ?? null,
          estimated_fare: verifiedFare,
          currency: body.currency,
          surge_multiplier: body.surgeMultiplier,
        },
        p_points: orderedPoints.map((p) => ({
          point_type: p.type,
          seq: p.seq,
          place_name: p.placeName ?? null,
          formatted_address: p.formattedAddress,
          lat: p.lat,
          lng: p.lng,
          provider_place_id: p.providerPlaceId ?? null,
          leg_distance_km: p.legDistanceKm ?? null,
          leg_duration_min: p.legDurationMin ?? null,
        })),
      });
      if (rpcError || !created) {
        console.error('Multi-stop ride creation failed:', rpcError);
        return NextResponse.json(
          { error: 'Could not create ride. Please try again.' },
          { status: 500 },
        );
      }
      rideData = created as CreatedRide;
    } else {
      const { data: inserted, error: rideError } = await supabase
        .from('rides')
        .insert({
          rider_id: user.id,
          quote_id: quoteId,
          status: 'searching_driver',
          pickup_address: body.pickupAddress,
          pickup_lat: body.pickupLat,
          pickup_lng: body.pickupLng,
          dropoff_address: body.dropoffAddress,
          dropoff_lat: body.dropoffLat,
          dropoff_lng: body.dropoffLng,
          vehicle_class: body.vehicleClass,
          distance_km: body.distanceKm,
          duration_min: body.durationMin,
          route_polyline: body.polyline ?? null,
          estimated_fare: verifiedFare,
          currency: body.currency,
          surge_multiplier: body.surgeMultiplier,
          requested_at: new Date().toISOString(),
        })
        .select('id, status, estimated_fare, currency, requested_at')
        .single();

      if (rideError || !inserted) {
        console.error('Ride creation failed:', rideError);
        return NextResponse.json(
          { error: 'Could not create ride. Please try again.' },
          { status: 500 },
        );
      }
      rideData = inserted;
    }

    // 5. Set up payment — authorize (hold funds) immediately
    let clientSecret: string | null = null;
    let paymentIntentId: string | null = null;

    // The payments table is server-owned financial state (no client INSERT
    // policy), so write it with the service role after the user is authenticated.
    const svcPayments = createServiceClient();
    try {
      if (body.paymentIntentId) {
        // The card was already authorized by the mobile PaymentSheet. Link that
        // intent to this ride (no second hold) and record it for capture. It is
        // already authorized by now, so the row starts 'authorized'; the
        // amount_capturable webhook is idempotent if it lands again.
        const linked = await attachRideToPaymentIntent(body.paymentIntentId, rideData.id);
        paymentIntentId = linked.id;

        await svcPayments.from('payments').insert({
          ride_id: rideData.id,
          rider_id: user.id,
          stripe_payment_intent: linked.id,
          amount: verifiedFare,
          currency: body.currency,
          status: linked.status === 'requires_capture' ? 'authorized' : 'pending',
        });
      } else {
        // Legacy path: no pre-authorized intent, create one here.
        const { data: rider } = await supabase
          .from('riders')
          .select('stripe_customer_id, full_name, email')
          .eq('id', user.id)
          .single();

        let customerId = rider?.stripe_customer_id;
        if (!customerId) {
          customerId = await findOrCreateCustomer(
            user.email ?? rider?.email ?? '',
            rider?.full_name ?? undefined,
            user.id,
          );
          await supabase.from('riders').update({ stripe_customer_id: customerId }).eq('id', user.id);
        }

        const amountCents = Math.round(verifiedFare * 100);
        const intent = await createPaymentIntent({
          amount: amountCents,
          currency: body.currency.toLowerCase(),
          customerId,
          rideId: rideData.id,
          description: `TakeMe ${body.vehicleClass}: ${body.pickupAddress} → ${body.dropoffAddress}`,
        });

        clientSecret = intent.clientSecret;
        paymentIntentId = intent.id;

        await svcPayments.from('payments').insert({
          ride_id: rideData.id,
          rider_id: user.id,
          stripe_payment_intent: intent.id,
          amount: verifiedFare,
          currency: body.currency,
          status: 'pending',
        });
      }
    } catch (payErr) {
      // Payment setup failure is non-fatal — ride is created, payment can retry
      console.warn('Payment setup failed (ride still created):', payErr);
    }

    // 6. Start the offer pipeline (non-blocking). Drivers must explicitly
    // accept an offer — rides are NEVER auto-assigned here. The rider app
    // learns about the assignment through realtime/push once a driver accepts.
    try {
      await dispatchWithRetry(rideData.id);
    } catch (dispatchErr) {
      console.warn('Dispatch enqueue failed (queue will retry):', dispatchErr);
    }

    // 7. Return ride + payment. `driver` is always null at creation time —
    // assignment only exists after a driver accepts the offer.
    return NextResponse.json({
      ride: {
        id: rideData.id,
        status: rideData.status,
        estimatedFare: rideData.estimated_fare,
        currency: rideData.currency,
        requestedAt: rideData.requested_at,
        quoteId,
      },
      payment: clientSecret ? {
        clientSecret,
        paymentIntentId,
      } : null,
      driver: null,
    }, { status: 201 });
  } catch (err) {
    console.error('POST /api/rides/create failed:', err);
    return NextResponse.json(
      { error: 'Something went wrong. Please try again.' },
      { status: 500 },
    );
  }
}
