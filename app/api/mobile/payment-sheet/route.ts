import { NextRequest, NextResponse } from 'next/server';
import { createApiClient } from '@/lib/supabase/api';

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/mobile/payment-sheet
//
// Creates everything the mobile PaymentSheet needs:
//   1. Find or create Stripe Customer
//   2. Create EphemeralKey for the customer
//   3. Create PaymentIntent (manual capture — authorize only)
//
// Returns: { clientSecret, ephemeralKey, customerId, paymentIntentId }
//
// Auth: requires the caller's Supabase bearer token. The ephemeral key grants
// access to a customer's saved payment methods, so the customer is derived from
// the authenticated user — never from a client-supplied id.
// ═══════════════════════════════════════════════════════════════════════════

const STRIPE_API = 'https://api.stripe.com/v1';

function getSecretKey(): string {
  const key = process.env.STRIPE_SECRET_KEY ?? '';
  if (!key) throw new Error('STRIPE_SECRET_KEY not configured');
  return key;
}

async function stripePost(path: string, body: Record<string, string>) {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getSecretKey()}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body).toString(),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data;
}

async function stripeGet(path: string, params?: Record<string, string>) {
  const url = new URL(`${STRIPE_API}${path}`);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${getSecretKey()}` },
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data;
}

/** Find existing customer by rider ID metadata, or create one */
async function findOrCreateCustomer(riderId: string, email?: string): Promise<string> {
  // Search by metadata
  const search = await stripeGet('/customers/search', {
    query: `metadata["rider_id"]:"${riderId}"`,
  });

  if (search.data?.length > 0) {
    return search.data[0].id;
  }

  // Create new customer
  const customer = await stripePost('/customers', {
    'metadata[rider_id]': riderId,
    'metadata[app]': 'takeme-rider',
    ...(email ? { email } : {}),
  });

  return customer.id;
}

export async function POST(request: NextRequest) {
  try {
    const { user } = await createApiClient(request);
    if (!user) {
      return NextResponse.json({ error: 'Sign in to set up payment.' }, { status: 401 });
    }

    const body = await request.json();
    const { amount, email } = body;
    // The customer is the authenticated user; ignore any client-supplied id.
    const riderId = user.id;

    if (!amount) {
      return NextResponse.json({ error: 'amount is required' }, { status: 400 });
    }

    const amountCents = Math.round(parseFloat(amount) * 100);
    if (amountCents < 50) {
      return NextResponse.json(
        { error: 'Amount must be at least $0.50' },
        { status: 400 },
      );
    }

    // 1. Find or create Stripe customer
    const customerId = await findOrCreateCustomer(riderId, email);
    console.log('[payment-sheet] Customer:', customerId);

    // 2. Create ephemeral key for the customer (mobile PaymentSheet needs
    //    this). Unlike every other Stripe call, this one REQUIRES an explicit
    //    Stripe-Version header — the plain stripePost helper would 500.
    const ephRes = await fetch(`${STRIPE_API}/ephemeral_keys`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${getSecretKey()}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Stripe-Version': '2024-12-18.acacia',
      },
      body: new URLSearchParams({ customer: customerId }).toString(),
    });
    const ephData = await ephRes.json();
    if (ephData.error) throw new Error(ephData.error.message);

    // 3. Create PaymentIntent — manual capture (authorize now, capture after ride)
    const paymentIntent = await stripePost('/payment_intents', {
      amount: amountCents.toString(),
      currency: 'usd',
      customer: customerId,
      capture_method: 'manual',
      'automatic_payment_methods[enabled]': 'true',
      'metadata[rider_id]': riderId,
      'metadata[app]': 'takeme-rider',
    });

    console.log('[payment-sheet] PaymentIntent:', paymentIntent.id, `$${(amountCents / 100).toFixed(2)}`);

    return NextResponse.json({
      clientSecret: paymentIntent.client_secret,
      ephemeralKey: ephData.secret,
      customerId,
      paymentIntentId: paymentIntent.id,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Payment setup failed';
    console.error('[payment-sheet] Error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
