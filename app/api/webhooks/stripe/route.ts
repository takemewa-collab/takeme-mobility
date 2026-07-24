import { NextRequest, NextResponse } from 'next/server';
import { verifyWebhookSignature } from '@/lib/stripe';
import { createServiceClient } from '@/lib/supabase/service';

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/webhooks/stripe
//
// Handles ALL Stripe webhook events — payments + Issuing.
//
// Payment events:
//   payment_intent.amount_capturable_updated
//   payment_intent.succeeded
//   payment_intent.payment_failed
//   charge.refunded / charge.dispute.created
//
// TAKEME Card (Issuing) events:
//   issuing_card.shipped / issuing_card.delivered
//   issuing_authorization.request
//   issuing_transaction.created
// ═══════════════════════════════════════════════════════════════════════════

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function logIssuingEvent(supabase: any, eventType: string, stripeId: string, userId: string | undefined, data: unknown) {
  try {
    await supabase.from('issuing_events').insert({
      event_type: eventType,
      stripe_id: stripeId,
      user_id: userId ?? null,
      data: data ?? {},
    });
  } catch (err) {
    console.warn('[Webhook] Event log failed:', err);
  }
}

export async function POST(request: NextRequest) {
  try {
    // 1. Read raw body for signature verification
    const rawBody = await request.text();
    const signature = request.headers.get('stripe-signature');

    if (!signature) {
      return NextResponse.json({ error: 'Missing signature' }, { status: 400 });
    }

    // 2. Verify webhook signature
    let event: Record<string, unknown>;
    try {
      event = await verifyWebhookSignature(rawBody, signature);
    } catch (err) {
      console.error('Webhook signature failed:', err);
      return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
    }

    const eventId = event.id as string;
    const eventType = event.type as string;
    const data = event.data as { object: Record<string, unknown> };
    const obj = data.object;

    console.log(`[Stripe Webhook] ${eventType}:`, obj.id);

    const supabase = createServiceClient();

    // Deduplicate: skip if we've already processed this event
    if (eventId) {
      const { error: dedupErr } = await supabase
        .from('processed_webhook_events')
        .insert({ event_id: eventId, event_type: eventType });

      if (dedupErr?.code === '23505') {
        // Unique constraint violation — already processed
        console.log(`[Stripe Webhook] Duplicate event skipped: ${eventId}`);
        return NextResponse.json({ received: true, duplicate: true });
      }
    }

    // 3. Route by event type.
    // The dedup row above is inserted BEFORE handling to block concurrent
    // duplicates, but if handling fails we must RELEASE that claim — otherwise
    // Stripe's retry hits the dedup and silently skips, permanently losing the
    // money mutation (balance update / payout.failed earning, etc.).
    try {
    switch (eventType) {
      // ── Authorization successful ─────────────────────────────────────
      case 'payment_intent.amount_capturable_updated': {
        const piId = obj.id as string;
        const rideId = (obj.metadata as Record<string, string>)?.ride_id;

        // Verify the payment exists in our database before updating
        const { data: existingPayment } = await supabase
          .from('payments')
          .select('id, rider_id, amount')
          .eq('stripe_payment_intent', piId)
          .single();

        if (!existingPayment) {
          console.warn(`[Webhook] Unknown PaymentIntent: ${piId}`);
          break;
        }

        // Verify authorized amount matches expected (within 1% tolerance)
        const authorizedAmountCents = obj.amount_capturable as number ?? obj.amount as number ?? 0;
        const expectedCents = Math.round(existingPayment.amount * 100);
        if (Math.abs(authorizedAmountCents - expectedCents) > expectedCents * 0.01) {
          console.error(`[Webhook] Amount mismatch for ${piId}: authorized=${authorizedAmountCents}, expected=${expectedCents}`);
          // Still update but flag it
        }

        await supabase
          .from('payments')
          .update({
            status: 'authorized',
            authorized_at: new Date().toISOString(),
          })
          .eq('id', existingPayment.id);

        // Save the payment method for future rides
        const pmId = obj.payment_method as string | null;
        if (pmId && existingPayment.rider_id) {
          await supabase
            .from('riders')
            .update({ default_payment_method: pmId })
            .eq('id', existingPayment.rider_id);

          await supabase
            .from('payments')
            .update({ payment_method_type: 'card' })
            .eq('id', existingPayment.id);
        }

        break;
      }

      // ── Capture succeeded (ride complete, funds collected) ───────────
      case 'payment_intent.succeeded': {
        const piId = obj.id as string;
        const chargeId = (obj.latest_charge as string) ?? null;

        await supabase
          .from('payments')
          .update({
            status: 'captured',
            stripe_charge_id: chargeId,
            captured_at: new Date().toISOString(),
          })
          .eq('stripe_payment_intent', piId);

        // Mark ride as completed if not already
        const rideId = (obj.metadata as Record<string, string>)?.ride_id;
        if (rideId) {
          await supabase
            .from('rides')
            .update({
              status: 'completed',
              final_fare: Number(obj.amount_received ?? obj.amount) / 100,
              trip_completed_at: new Date().toISOString(),
            })
            .eq('id', rideId)
            .neq('status', 'completed');

          // Credit the driver's share of the captured fare. Idempotent per
          // ride — the driver-complete API path usually settles first and
          // this is the Stripe-retried safety net.
          const { creditRideEarning } = await import('@/lib/earnings');
          await creditRideEarning({
            rideId,
            fareAmount: Number(obj.amount_received ?? obj.amount) / 100,
          });
        }

        break;
      }

      // ── Payment failed ──────────────────────────────────────────────
      case 'payment_intent.payment_failed': {
        const piId = obj.id as string;
        const lastError = obj.last_payment_error as { message?: string } | null;

        await supabase
          .from('payments')
          .update({
            status: 'failed',
            failed_at: new Date().toISOString(),
            failure_reason: lastError?.message ?? 'Payment declined',
          })
          .eq('stripe_payment_intent', piId);

        break;
      }

      // ── Refund processed ────────────────────────────────────────────
      case 'charge.refunded': {
        const piId = obj.payment_intent as string;

        if (piId) {
          await supabase
            .from('payments')
            .update({
              status: 'refunded',
              refunded_at: new Date().toISOString(),
            })
            .eq('stripe_payment_intent', piId);
        }

        break;
      }

      // ── Dispute opened ──────────────────────────────────────────────
      case 'charge.dispute.created': {
        const piId = (obj.payment_intent as string) ?? null;

        if (piId) {
          await supabase
            .from('payments')
            .update({ status: 'disputed' })
            .eq('stripe_payment_intent', piId);
        }

        console.warn('[Stripe Webhook] DISPUTE created:', obj.id);
        break;
      }

      // ════════════════════════════════════════════════════════════════
      // TAKEME CARD — Stripe Issuing events
      // ════════════════════════════════════════════════════════════════

      // ── Physical card shipped ───────────────────────────────────────
      case 'issuing_card.shipped': {
        const cardId = obj.id as string;
        const userId = (obj.metadata as Record<string, string>)?.user_id;

        console.log(`[Webhook] Card shipped: ${cardId}`);

        await supabase
          .from('driver_cards')
          .update({ shipping_status: 'shipped' })
          .eq('stripe_physical_card_id', cardId);

        // Also update takeme_cards if exists
        await supabase
          .from('takeme_cards')
          .update({ physical_status: 'shipping' })
          .eq('stripe_card_id', cardId);

        await logIssuingEvent(supabase, 'card_shipped', cardId, userId, obj);
        break;
      }

      // ── Physical card delivered ─────────────────────────────────────
      case 'issuing_card.delivered': {
        const cardId = obj.id as string;
        const userId = (obj.metadata as Record<string, string>)?.user_id;

        console.log(`[Webhook] Card delivered: ${cardId}`);

        await supabase
          .from('driver_cards')
          .update({ shipping_status: 'delivered', card_status: 'needs_activation' })
          .eq('stripe_physical_card_id', cardId);

        await supabase
          .from('takeme_cards')
          .update({ physical_status: 'delivered', physical_delivered_at: new Date().toISOString() })
          .eq('stripe_card_id', cardId);

        await logIssuingEvent(supabase, 'card_delivered', cardId, userId, obj);
        break;
      }

      // ── Authorization request (real-time spending) ──────────────────
      case 'issuing_authorization.request': {
        const authId = obj.id as string;
        const cardId = obj.card as string ?? (obj.card as Record<string, unknown>)?.id as string;
        const amount = obj.amount as number ?? 0;
        const merchantName = (obj.merchant_data as Record<string, unknown>)?.name as string ?? 'Unknown';
        const merchantCategory = (obj.merchant_data as Record<string, unknown>)?.category as string ?? '';
        const userId = (obj.metadata as Record<string, string>)?.user_id;

        console.log(`[Webhook] Auth request: $${(amount / 100).toFixed(2)} at ${merchantName}`);

        // Log the authorization
        await logIssuingEvent(supabase, 'authorization_request', authId, userId, {
          card_id: cardId,
          amount_cents: amount,
          merchant: merchantName,
          category: merchantCategory,
        });

        // Track in card_transactions
        if (userId) {
          const { data: card } = await supabase
            .from('takeme_cards')
            .select('id')
            .eq('stripe_card_id', cardId)
            .maybeSingle();

          if (card) {
            await supabase.from('card_transactions').insert({
              card_id: card.id,
              user_id: userId,
              type: 'charge',
              amount: amount / 100,
              description: merchantName,
              category: merchantCategory,
              status: 'pending',
            });
          }
        }

        break;
      }

      // ── Transaction created (finalized spend) ───────────────────────
      case 'issuing_transaction.created': {
        const txnId = obj.id as string;
        const cardId = obj.card as string ?? (obj.card as Record<string, unknown>)?.id as string;
        const amount = Math.abs(obj.amount as number ?? 0);
        const merchantName = (obj.merchant_data as Record<string, unknown>)?.name as string ?? 'Unknown';
        const merchantCategory = (obj.merchant_data as Record<string, unknown>)?.category as string ?? '';
        const userId = (obj.metadata as Record<string, string>)?.user_id;

        console.log(`[Webhook] Transaction: $${(amount / 100).toFixed(2)} at ${merchantName}`);

        // Find the card in our DB
        const { data: card } = await supabase
          .from('takeme_cards')
          .select('id, balance, total_cashback, cashback_rate_ev, cashback_rate_gas, cashback_rate_other')
          .eq('stripe_card_id', cardId)
          .maybeSingle();

        if (card && userId) {
          const amountDollars = amount / 100;

          // Calculate cashback
          let cashbackRate = Number(card.cashback_rate_other) / 100;
          if (merchantCategory.includes('electric') || merchantCategory.includes('fuel_electric')) {
            cashbackRate = Number(card.cashback_rate_ev) / 100;
          } else if (merchantCategory.includes('fuel') || merchantCategory.includes('gas')) {
            cashbackRate = Number(card.cashback_rate_gas) / 100;
          }
          const cashback = Math.round(amountDollars * cashbackRate * 100) / 100;

          // Update card balance and cashback
          await supabase
            .from('takeme_cards')
            .update({
              balance: Number(card.balance) - amountDollars,
              total_cashback: Number(card.total_cashback) + cashback,
            })
            .eq('id', card.id);

          // Update driver_balances card_balance
          await supabase.rpc('decrement_card_balance', { p_driver_id: userId, p_amount: amountDollars });

          // Store finalized transaction
          await supabase.from('card_transactions').insert({
            card_id: card.id,
            user_id: userId,
            type: 'charge',
            amount: amountDollars,
            description: merchantName,
            category: merchantCategory,
            status: 'completed',
          });

          // Store cashback as separate transaction
          if (cashback > 0) {
            await supabase.from('card_transactions').insert({
              card_id: card.id,
              user_id: userId,
              type: 'cashback',
              amount: cashback,
              description: `${(cashbackRate * 100).toFixed(0)}% cashback: ${merchantName}`,
              category: 'cashback_reward',
              status: 'completed',
            });
          }
        }

        await logIssuingEvent(supabase, 'transaction_created', txnId, userId, {
          card_id: cardId,
          amount_cents: amount,
          merchant: merchantName,
          category: merchantCategory,
        });

        break;
      }

      // ════════════════════════════════════════════════════════════════
      // DRIVER PAYOUTS
      // ════════════════════════════════════════════════════════════════

      case 'payout.paid': {
        const payoutId = obj.id as string;
        console.log(`[Webhook] Payout paid: ${payoutId}`);

        await supabase
          .from('driver_payouts')
          .update({ status: 'paid', completed_at: new Date().toISOString() })
          .eq('stripe_payout_id', payoutId);
        break;
      }

      case 'payout.failed': {
        const payoutId = obj.id as string;
        const reason = (obj.failure_message as string) ?? 'Payout failed';
        console.error(`[Webhook] Payout failed: ${payoutId} — ${reason}`);

        // Get payout record to refund the balance
        const { data: failedPayout } = await supabase
          .from('driver_payouts')
          .select('driver_id, amount')
          .eq('stripe_payout_id', payoutId)
          .single();

        if (failedPayout) {
          // Restore funds to wallet
          await supabase.rpc('add_driver_earning', {
            p_driver_id: failedPayout.driver_id,
            p_amount: failedPayout.amount,
            p_type: 'adjustment',
            p_description: `Payout failed — funds returned: ${reason}`,
          });
        }

        await supabase
          .from('driver_payouts')
          .update({ status: 'failed', failure_reason: reason })
          .eq('stripe_payout_id', payoutId);
        break;
      }

      default:
        console.log(`[Stripe Webhook] Unhandled event: ${eventType}`);
    }
    } catch (handlerErr) {
      // Release the dedup claim so Stripe's automatic retry re-processes this
      // event instead of being deduped away.
      if (eventId) {
        await supabase.from('processed_webhook_events').delete().eq('event_id', eventId);
      }
      throw handlerErr;
    }

    return NextResponse.json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err);
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
  }
}
