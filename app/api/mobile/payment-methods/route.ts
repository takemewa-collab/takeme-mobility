import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createApiClient } from '@/lib/supabase/api';
import { findOrCreateMobileCustomer, stripeGet, stripeRequest } from '@/lib/stripe';

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/mobile/payment-methods
//
// The Wallet screen's card management, one action per call:
//   { action: "list" }                              → saved cards + default
//   { action: "detach",     paymentMethodId }       → remove a saved card
//   { action: "setDefault", paymentMethodId|null }  → default card; null
//                                                     clears it (Apple Pay)
//
// Every action resolves the Stripe customer from the AUTHENTICATED user and
// verifies card ownership before mutating — client-supplied customer ids are
// never trusted.
// ═══════════════════════════════════════════════════════════════════════════

const requestSchema = z.object({
  action: z.enum(['list', 'detach', 'setDefault']),
  paymentMethodId: z.string().startsWith('pm_').nullish(),
});

type Card = {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  isDefault: boolean;
};

async function listCards(customerId: string): Promise<Card[]> {
  const [customer, methods] = await Promise.all([
    stripeGet(`/customers/${customerId}`),
    stripeGet(`/payment_methods?customer=${customerId}&type=card&limit=20`),
  ]);
  const defaultId =
    ((customer as { invoice_settings?: { default_payment_method?: string | null } })
      .invoice_settings?.default_payment_method as string | null) ?? null;
  const rows =
    (methods as {
      data?: {
        id: string;
        card?: { brand?: string; last4?: string; exp_month?: number; exp_year?: number };
      }[];
    }).data ?? [];
  return rows.map((pm) => ({
    id: pm.id,
    brand: pm.card?.brand ?? 'card',
    last4: pm.card?.last4 ?? '••••',
    expMonth: pm.card?.exp_month ?? 0,
    expYear: pm.card?.exp_year ?? 0,
    isDefault: pm.id === defaultId,
  }));
}

/** True when the payment method is attached to this customer. */
async function ownsMethod(customerId: string, paymentMethodId: string): Promise<boolean> {
  try {
    const pm = (await stripeGet(`/payment_methods/${paymentMethodId}`)) as {
      customer?: string | null;
    };
    return pm.customer === customerId;
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  try {
    const { user } = await createApiClient(request);
    if (!user) {
      return NextResponse.json({ error: 'Sign in to manage payment methods.' }, { status: 401 });
    }

    let body: z.infer<typeof requestSchema>;
    try {
      body = requestSchema.parse(await request.json());
    } catch {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }

    const customerId = await findOrCreateMobileCustomer(user.id, user.email);

    if (body.action === 'detach') {
      if (!body.paymentMethodId) {
        return NextResponse.json({ error: 'paymentMethodId is required' }, { status: 400 });
      }
      if (!(await ownsMethod(customerId, body.paymentMethodId))) {
        return NextResponse.json({ error: 'Payment method not found.' }, { status: 404 });
      }
      await stripeRequest(`/payment_methods/${body.paymentMethodId}/detach`, {});
    }

    if (body.action === 'setDefault') {
      if (body.paymentMethodId) {
        if (!(await ownsMethod(customerId, body.paymentMethodId))) {
          return NextResponse.json({ error: 'Payment method not found.' }, { status: 404 });
        }
        await stripeRequest(`/customers/${customerId}`, {
          'invoice_settings[default_payment_method]': body.paymentMethodId,
        });
      } else {
        // Clearing the card default makes Apple Pay the effective default.
        await stripeRequest(`/customers/${customerId}`, {
          'invoice_settings[default_payment_method]': '',
        });
      }
    }

    return NextResponse.json({ cards: await listCards(customerId) });
  } catch (error) {
    console.error('POST /api/mobile/payment-methods failed:', error);
    return NextResponse.json({ error: 'Could not load payment methods.' }, { status: 500 });
  }
}
