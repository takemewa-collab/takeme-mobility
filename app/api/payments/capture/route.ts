import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { capturePaymentIntent } from '@/lib/stripe';

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/payments/capture
//
// Captures an authorized PaymentIntent after ride completion.
// Optionally adjusts the capture amount if the final fare differs
// from the estimated fare (e.g., route change, wait time).
// ═══════════════════════════════════════════════════════════════════════════

const requestSchema = z.object({
  rideId: z.string().uuid(),
});

export async function POST(request: NextRequest) {
  try {
    // 1. Authenticate
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 2. Parse
    let body: z.infer<typeof requestSchema>;
    try {
      body = requestSchema.parse(await request.json());
    } catch {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }

    // 3. Fetch ride — verify ownership
    const { data: ride } = await supabase
      .from('rides')
      .select('id, rider_id, estimated_fare, status')
      .eq('id', body.rideId)
      .single();

    if (!ride || ride.rider_id !== user.id) {
      return NextResponse.json({ error: 'Ride not found' }, { status: 404 });
    }

    // 4. Fetch payment — use service client to bypass RLS for cross-table validation
    const svc = createServiceClient();
    const { data: payment } = await svc
      .from('payments')
      .select('id, stripe_payment_intent, status, rider_id')
      .eq('ride_id', body.rideId)
      .eq('status', 'authorized')
      .single();

    if (!payment?.stripe_payment_intent) {
      return NextResponse.json({ error: 'No authorized payment found for this ride' }, { status: 400 });
    }

    // Verify payment belongs to this rider
    if (payment.rider_id !== user.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    }

    // 5. Capture the AUTHORIZED amount. The final amount must never be taken
    //    from the client — the caller here is the rider (ownership checked
    //    above), so a client-supplied fare let them capture $0.01 for a real
    //    ride. Any legitimate fare reduction must be computed server-side from
    //    ride telemetry and applied as a partial capture / refund, not trusted
    //    from the payer.
    const finalAmount = ride.estimated_fare;

    // 6. Capture via Stripe
    const amountCents = Math.round(finalAmount * 100);
    const result = await capturePaymentIntent(payment.stripe_payment_intent, amountCents);

    // 7. Update payment + ride atomically via service client
    const now = new Date().toISOString();

    await Promise.all([
      svc.from('payments').update({
        status: 'captured',
        amount: finalAmount,
        captured_at: now,
      }).eq('id', payment.id),

      svc.from('rides').update({
        final_fare: finalAmount,
        status: 'completed',
        trip_completed_at: now,
      }).eq('id', body.rideId),
    ]);

    // 8. Log event
    await svc.from('ride_events').insert({
      ride_id: body.rideId,
      event_type: 'payment_captured',
      actor: 'system',
      metadata: {
        payment_intent_id: result.id,
        estimated_fare: ride.estimated_fare,
        final_fare: finalAmount,
        adjusted: false,
      },
    });

    return NextResponse.json({
      captured: true,
      paymentIntentId: result.id,
      finalFare: finalAmount,
    });
  } catch (err) {
    console.error('POST /api/payments/capture failed:', err);
    return NextResponse.json({ error: 'Payment capture failed. Please try again.' }, { status: 500 });
  }
}
