import { NextRequest, NextResponse } from 'next/server';
import { createApiClient } from '@/lib/supabase/api';
import { createEphemeralKey, findOrCreateMobileCustomer, stripeRequest } from '@/lib/stripe';

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/mobile/setup-intent
//
// Backs the Wallet's "add payment method" flow: a SetupIntent presented in
// the mobile PaymentSheet saves a card to the rider's Stripe customer without
// charging it. Returns { setupIntentClientSecret, ephemeralKey, customerId }.
// ═══════════════════════════════════════════════════════════════════════════

export async function POST(request: NextRequest) {
  try {
    const { user } = await createApiClient(request);
    if (!user) {
      return NextResponse.json({ error: 'Sign in to add a payment method.' }, { status: 401 });
    }

    const customerId = await findOrCreateMobileCustomer(user.id, user.email);
    const [ephemeralKey, setupIntent] = await Promise.all([
      createEphemeralKey(customerId),
      stripeRequest('/setup_intents', {
        customer: customerId,
        usage: 'off_session',
        'payment_method_types[]': 'card',
        'metadata[rider_id]': user.id,
        'metadata[app]': 'takeme-rider',
      }),
    ]);

    return NextResponse.json({
      setupIntentClientSecret: (setupIntent as { client_secret: string }).client_secret,
      ephemeralKey,
      customerId,
    });
  } catch (error) {
    console.error('POST /api/mobile/setup-intent failed:', error);
    return NextResponse.json({ error: 'Could not start the add-card flow.' }, { status: 500 });
  }
}
