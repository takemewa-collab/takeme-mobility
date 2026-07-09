import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/stripe/webhook
//
// Handles Stripe Checkout webhook events.
// On checkout.session.completed → update booking status to 'confirmed'.
// ═══════════════════════════════════════════════════════════════════════════

export async function POST(request: NextRequest) {
  try {
    const body = await request.text();
    const signature = request.headers.get('stripe-signature');

    // Fail closed: a webhook that flips bookings to `confirmed` must ALWAYS be
    // signature-verified. Previously verification was skipped when the secret
    // or signature was absent, so a spoofed POST could confirm rides for free.
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error('[Stripe Webhook] STRIPE_WEBHOOK_SECRET not configured — rejecting');
      return NextResponse.json({ error: 'Webhook not configured' }, { status: 500 });
    }
    if (!signature) {
      return NextResponse.json({ error: 'Missing signature' }, { status: 400 });
    }
    {
      const crypto = await import('crypto');
      const parts = signature.split(',');
      const timestamp = parts.find(p => p.startsWith('t='))?.slice(2);
      const sig = parts.find(p => p.startsWith('v1='))?.slice(3);

      if (!timestamp || !sig) {
        return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
      }

      const expected = crypto
        .createHmac('sha256', webhookSecret)
        .update(`${timestamp}.${body}`)
        .digest('hex');

      // Constant-time compare to avoid a timing side-channel.
      const sigBuf = Buffer.from(sig, 'hex');
      const expBuf = Buffer.from(expected, 'hex');
      if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
        return NextResponse.json({ error: 'Signature mismatch' }, { status: 400 });
      }

      // Check timestamp (5 min tolerance)
      if (Math.floor(Date.now() / 1000) - parseInt(timestamp) > 300) {
        return NextResponse.json({ error: 'Timestamp too old' }, { status: 400 });
      }
    }

    const event = JSON.parse(body);
    const type = event.type as string;

    console.log(`[Stripe Webhook] ${type}`);

    if (type === 'checkout.session.completed') {
      const session = event.data.object;
      const rideId = session.metadata?.ride_id;
      const paymentId = session.payment_intent;

      if (rideId) {
        const supabase = createServiceClient();

        await supabase
          .from('bookings')
          .update({
            status: 'confirmed',
            stripe_payment_id: paymentId,
          })
          .eq('id', rideId)
          .eq('status', 'pending');

        console.log(`[Stripe Webhook] Booking ${rideId} confirmed`);
      }
    }

    return NextResponse.json({ received: true });
  } catch (err) {
    console.error('[Stripe Webhook] Error:', err);
    return NextResponse.json({ error: 'Webhook failed' }, { status: 500 });
  }
}
