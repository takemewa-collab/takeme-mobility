import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createApiClient } from '@/lib/supabase/api';
import { createServiceClient } from '@/lib/supabase/service';
import { createEphemeralKey, findOrCreateMobileCustomer, stripeGet, stripeRequest } from '@/lib/stripe';

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/mobile/credit
//
// TAKEME Credit — the rider's in-app balance (ride credits, refunds, promos,
// gifts). Backed by the append-only rider_credit_ledger table; every write
// happens here with the service role.
//
//   { action: "summary" }                      → { balanceCents, entries }
//   { action: "topupIntent", amountUsd }       → PaymentSheet bundle
//   { action: "confirmTopup", paymentIntentId }→ verifies the intent with
//     Stripe and appends the ledger entry (idempotent — the intent id is
//     unique in the ledger, a retried confirm can never double-credit).
// ═══════════════════════════════════════════════════════════════════════════

const requestSchema = z.object({
  action: z.enum(['summary', 'topupIntent', 'confirmTopup']),
  amountUsd: z.number().min(5).max(200).optional(),
  paymentIntentId: z.string().startsWith('pi_').optional(),
});

async function summary(userId: string) {
  const svc = createServiceClient();
  // The full ledger is small per rider; balance = sum over every row, the
  // screen shows only the newest slice.
  const { data, error } = await svc
    .from('rider_credit_ledger')
    .select('id, amount_cents, kind, note, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1000);
  if (error) throw error;
  const entries = data ?? [];
  const balanceCents = entries.reduce((sum, row) => sum + (row.amount_cents ?? 0), 0);
  return { balanceCents, entries: entries.slice(0, 25) };
}

export async function POST(request: NextRequest) {
  try {
    const { user } = await createApiClient(request);
    if (!user) {
      return NextResponse.json({ error: 'Sign in to use TAKEME Credit.' }, { status: 401 });
    }

    let body: z.infer<typeof requestSchema>;
    try {
      body = requestSchema.parse(await request.json());
    } catch {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }

    if (body.action === 'topupIntent') {
      if (!body.amountUsd) {
        return NextResponse.json({ error: 'amountUsd is required (5–200).' }, { status: 400 });
      }
      const amountCents = Math.round(body.amountUsd * 100);
      const customerId = await findOrCreateMobileCustomer(user.id, user.email);
      const [ephemeralKey, intent] = await Promise.all([
        createEphemeralKey(customerId),
        stripeRequest('/payment_intents', {
          amount: amountCents.toString(),
          currency: 'usd',
          customer: customerId,
          // Top-ups charge immediately — no ride to wait for.
          'automatic_payment_methods[enabled]': 'true',
          'metadata[type]': 'credit_topup',
          'metadata[user_id]': user.id,
          'metadata[app]': 'takeme-rider',
        }),
      ]);
      const pi = intent as { id: string; client_secret: string };
      return NextResponse.json({
        clientSecret: pi.client_secret,
        paymentIntentId: pi.id,
        ephemeralKey,
        customerId,
      });
    }

    if (body.action === 'confirmTopup') {
      if (!body.paymentIntentId) {
        return NextResponse.json({ error: 'paymentIntentId is required.' }, { status: 400 });
      }
      const intent = (await stripeGet(`/payment_intents/${body.paymentIntentId}`)) as {
        id: string;
        status: string;
        amount: number;
        metadata?: Record<string, string>;
      };
      if (
        intent.metadata?.type !== 'credit_topup' ||
        intent.metadata?.user_id !== user.id ||
        intent.status !== 'succeeded'
      ) {
        return NextResponse.json({ error: 'Top-up not confirmed yet.' }, { status: 409 });
      }
      const svc = createServiceClient();
      // Unique stripe_payment_intent_id makes replays a no-op.
      const { error } = await svc.from('rider_credit_ledger').insert({
        user_id: user.id,
        amount_cents: intent.amount,
        kind: 'topup',
        note: 'Added funds',
        stripe_payment_intent_id: intent.id,
      });
      // 23505 = duplicate intent id → the top-up was already credited.
      if (error && error.code !== '23505') throw error;
    }

    return NextResponse.json(await summary(user.id));
  } catch (error) {
    console.error('POST /api/mobile/credit failed:', error);
    return NextResponse.json({ error: 'Could not load TAKEME Credit.' }, { status: 500 });
  }
}
