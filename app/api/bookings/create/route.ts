import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { SEATTLE_TIERS, calculateFare, kmToMiles, type PetSize } from '@/lib/seattle-pricing';

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/bookings/create
//
// 1. Validates inputs
// 2. Recalculates price server-side (never trusts frontend)
// 3. Inserts booking into Supabase (status: pending)
// 4. If Stripe is configured, creates Checkout session
// 5. Returns booking + optional checkout URL
// ═══════════════════════════════════════════════════════════════════════════

const requestSchema = z.object({
  pickupAddress: z.string().min(1),
  pickupLat: z.number().min(-90).max(90),
  pickupLng: z.number().min(-180).max(180),
  destinationAddress: z.string().min(1),
  destinationLat: z.number().min(-90).max(90),
  destinationLng: z.number().min(-180).max(180),
  distanceKm: z.number().positive(),
  durationMin: z.number().int().positive(),
  vehicleType: z.enum(['electric', 'comfort_electric', 'premium_electric', 'suv_electric', 'women_rider', 'pet_ride']),
  // Airport
  airline: z.string().optional(),
  flightNumber: z.string().max(10).optional(),
  // Passenger
  rideFor: z.enum(['me', 'someone', 'vip']).optional(),
  passengerName: z.string().optional(),
  passengerPhone: z.string().optional(),
  driverNotes: z.string().max(500).optional(),
  meetGreet: z.boolean().optional(),
  nameSign: z.boolean().optional(),
  // Pet
  petType: z.enum(['dog', 'cat', 'other']).optional(),
  petSize: z.enum(['small', 'medium', 'large']).optional(),
  petNotes: z.string().max(200).optional(),
});

export async function POST(request: NextRequest) {
  try {
    // 1. Auth
    let supabase;
    try {
      supabase = await createClient();
    } catch (err) {
      console.error('[bookings/create] Supabase client failed:', err);
      return NextResponse.json({ error: 'Service temporarily unavailable.' }, { status: 503 });
    }

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: 'Sign in to book a ride.' }, { status: 401 });
    }

    // 2. Parse
    let body: z.infer<typeof requestSchema>;
    try {
      body = requestSchema.parse(await request.json());
    } catch (err) {
      const msg = err instanceof z.ZodError
        ? err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
        : 'Invalid request';
      return NextResponse.json({ error: msg }, { status: 400 });
    }

    // 3. Server-side price calculation
    const tier = SEATTLE_TIERS.find(t => t.id === body.vehicleType);
    if (!tier) {
      return NextResponse.json({ error: 'Invalid vehicle type.' }, { status: 400 });
    }

    const fare = calculateFare(tier, body.distanceKm, body.durationMin, body.petSize as PetSize | undefined);
    const distanceMiles = kmToMiles(body.distanceKm);

    if (fare.total > 500) {
      return NextResponse.json({ error: 'Fare exceeds maximum. Try a shorter route.' }, { status: 400 });
    }

    // 4. Insert booking
    const { data: booking, error: insertError } = await supabase
      .from('bookings')
      .insert({
        user_id: user.id,
        pickup_address: body.pickupAddress,
        pickup_lat: body.pickupLat,
        pickup_lng: body.pickupLng,
        destination_address: body.destinationAddress,
        destination_lat: body.destinationLat,
        destination_lng: body.destinationLng,
        distance_miles: distanceMiles,
        duration_minutes: body.durationMin,
        vehicle_type: body.vehicleType,
        price: fare.total,
        currency: 'USD',
        status: 'pending',
        // Airport
        is_airport_trip: !!(body.airline),
        airline: body.airline ?? null,
        flight_number: body.flightNumber ?? null,
        // Passenger
        ride_for: body.rideFor ?? 'me',
        passenger_name: body.passengerName ?? null,
        passenger_phone: body.passengerPhone ?? null,
        driver_notes: body.driverNotes ?? null,
        meet_greet: body.meetGreet ?? false,
        name_sign: body.nameSign ?? false,
        // Pet
        pet_type: body.petType ?? null,
        pet_size: body.petSize ?? null,
        pet_notes: body.petNotes ?? null,
        pet_fee: fare.petFee,
      })
      .select('id, price')
      .single();

    if (insertError || !booking) {
      // Log the real error server-side; return a generic message to the client.
      console.error('[bookings/create] Insert failed:', insertError);
      return NextResponse.json({ error: 'Could not create booking' }, { status: 500 });
    }

    // 5. Stripe Checkout. A booking must NOT be confirmed without payment —
    //    doing so previously handed out free rides on any Stripe error or when
    //    the key was missing. The booking stays `pending` until Checkout
    //    completes and the (signature-verified) webhook confirms it.
    let checkoutUrl: string | null = null;

    const stripeKey = process.env.STRIPE_SECRET_KEY;
    const stripeConfigured = !!stripeKey && !stripeKey.includes('PASTE');

    if (stripeConfigured) {
      try {
        const { createCheckoutSession } = await import('@/lib/stripe');
        const origin = request.headers.get('origin') || 'https://takememobility.com';

        const session = await createCheckoutSession({
          rideId: booking.id,
          amount: Math.round(fare.total * 100),
          currency: 'usd',
          customerEmail: user.email ?? undefined,
          successUrl: `${origin}/booking/success?id=${booking.id}`,
          cancelUrl: `${origin}/?cancelled=true`,
        });

        checkoutUrl = session.url;

        await supabase
          .from('bookings')
          .update({ stripe_session_id: session.id })
          .eq('id', booking.id);
      } catch (stripeErr) {
        // Payment could not be initialized — leave the booking pending (unpaid)
        // and tell the client. Never auto-confirm.
        console.error('[bookings/create] Stripe checkout failed:', stripeErr);
        return NextResponse.json(
          { error: 'Payment could not be started. Please try again.', bookingId: booking.id },
          { status: 402 },
        );
      }
    } else if (process.env.NODE_ENV === 'production') {
      // Misconfiguration in production: refuse rather than give a free ride.
      console.error('[bookings/create] STRIPE_SECRET_KEY missing in production');
      return NextResponse.json({ error: 'Payments are temporarily unavailable' }, { status: 503 });
    } else {
      // Local/dev only (no Stripe configured): auto-confirm for testing.
      await supabase
        .from('bookings')
        .update({ status: 'confirmed' })
        .eq('id', booking.id);
    }

    return NextResponse.json({
      bookingId: booking.id,
      price: fare.total,
      distanceMiles,
      durationMin: body.durationMin,
      vehicleType: body.vehicleType,
      checkoutUrl,
    }, { status: 201 });

  } catch (err) {
    console.error('[bookings/create] Unhandled:', err);
    const msg = err instanceof Error ? err.message : 'Booking failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
