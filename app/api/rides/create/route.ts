import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getRequestAuth } from '@/lib/auth/request-user';
import { findOrCreateCustomer, createPaymentIntent } from '@/lib/stripe';
import { dispatchWithRetry } from '@/lib/dispatch-queue';
import { TIERS, calculateFare, type VehicleClass } from '@/lib/pricing';
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
});

export async function POST(request: NextRequest) {
  try {
    // 0. Rate limit
    const rateLimited = await rateLimit(request, 'rides-create');
    if (rateLimited) return rateLimited;

    // 1. Authenticate (web cookie session or mobile Bearer token)
    const auth = await getRequestAuth(request);
    if (!auth) {
      return NextResponse.json(
        { error: 'Sign in to book a ride.' },
        { status: 401 },
      );
    }
    const { user, supabase } = auth;

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

    // 3. Server-side fare verification — prevent client-side price manipulation
    const tier = TIERS[body.vehicleClass as VehicleClass];
    if (!tier) {
      return NextResponse.json({ error: 'Invalid vehicle class' }, { status: 400 });
    }

    const serverFare = calculateFare(tier, body.distanceKm, body.durationMin, {
      surgeMultiplier: body.surgeMultiplier,
      currency: body.currency,
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

    // 4. Create ride record
    const { data: rideData, error: rideError } = await supabase
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

    if (rideError || !rideData) {
      console.error('Ride creation failed:', rideError);
      return NextResponse.json(
        { error: 'Could not create ride. Please try again.' },
        { status: 500 },
      );
    }

    // 5. Set up payment — authorize (hold funds) immediately
    let clientSecret: string | null = null;
    let paymentIntentId: string | null = null;

    try {
      // Ensure Stripe customer
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

      // Create PaymentIntent with manual capture
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

      // Write payment record
      await supabase.from('payments').insert({
        ride_id: rideData.id,
        rider_id: user.id,
        stripe_payment_intent: intent.id,
        amount: verifiedFare,
        currency: body.currency,
        status: 'pending',
      });
    } catch (payErr) {
      // Payment setup failure is non-fatal — ride is created, payment can retry
      console.warn('Payment setup failed (ride still created):', payErr);
    }

    // 6. Start dispatch queue (non-blocking, retries in background)
    // Fire-and-forget: the queue retries with backoff and updates ride status
    let assignedDriver: { name: string; vehicle: string; plate: string } | null = null;
    try {
      // First attempt is synchronous for fast matching
      const { assignDriver } = await import('@/lib/dispatch');
      const dispatch = await assignDriver(rideData.id);
      if (dispatch.success && dispatch.driver) {
        assignedDriver = {
          name: dispatch.driver.driver_name,
          vehicle: `${dispatch.driver.vehicle_make} ${dispatch.driver.vehicle_model}`,
          plate: dispatch.driver.plate_number,
        };
      } else {
        // No immediate match — start background retry queue
        dispatchWithRetry(rideData.id).catch(err =>
          console.error('[dispatch-queue] Background dispatch failed:', err)
        );
      }
    } catch (dispatchErr) {
      console.warn('Auto-dispatch failed, starting retry queue:', dispatchErr);
      dispatchWithRetry(rideData.id).catch(() => {});
    }

    // 7. Return ride + payment + driver
    return NextResponse.json({
      ride: {
        id: rideData.id,
        status: assignedDriver ? 'driver_assigned' : rideData.status,
        estimatedFare: rideData.estimated_fare,
        currency: rideData.currency,
        requestedAt: rideData.requested_at,
        quoteId,
      },
      payment: clientSecret ? {
        clientSecret,
        paymentIntentId,
      } : null,
      driver: assignedDriver,
    }, { status: 201 });
  } catch (err) {
    console.error('POST /api/rides/create failed:', err);
    return NextResponse.json(
      { error: 'Something went wrong. Please try again.' },
      { status: 500 },
    );
  }
}
