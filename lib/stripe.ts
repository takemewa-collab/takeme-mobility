// ═══════════════════════════════════════════════════════════════════════════
// TAKEME MOBILITY — Stripe Server Helpers
// All Stripe API calls go through this module. Uses REST directly to avoid
// ESM/CJS bundling issues with the stripe npm package in Next.js edge/server.
// ═══════════════════════════════════════════════════════════════════════════

const STRIPE_API = 'https://api.stripe.com/v1';

function getSecretKey(): string {
  const key = process.env.STRIPE_SECRET_KEY ?? '';
  if (!key || key.includes('PASTE_YOUR')) {
    throw new Error('STRIPE_SECRET_KEY is not configured');
  }
  return key;
}

async function stripeRequest(
  path: string,
  params: Record<string, string>,
  method: 'POST' | 'GET' = 'POST',
  idempotencyKey?: string,
): Promise<Record<string, unknown>> {
  const key = getSecretKey();

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (idempotencyKey) {
    headers['Idempotency-Key'] = idempotencyKey;
  }

  const res = await fetch(`${STRIPE_API}${path}`, {
    method,
    headers,
    body: method === 'POST' ? new URLSearchParams(params).toString() : undefined,
  });

  const data = await res.json();

  if (!res.ok) {
    const msg = (data as { error?: { message?: string } })?.error?.message || `Stripe error ${res.status}`;
    throw new Error(msg);
  }

  return data;
}

async function stripeGet(path: string): Promise<Record<string, unknown>> {
  const key = getSecretKey();
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${key}` },
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = (data as { error?: { message?: string } })?.error?.message || `Stripe error ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

// ── Customer management ──────────────────────────────────────────────────

export async function findOrCreateCustomer(
  email: string,
  name: string | undefined,
  riderId: string,
): Promise<string> {
  // Search for existing customer by metadata
  const search = await stripeGet(`/customers/search?query=metadata['rider_id']:'${riderId}'`);
  const customers = (search as { data?: { id: string }[] }).data;
  if (customers && customers.length > 0) {
    return customers[0].id;
  }

  // Create new customer
  const params: Record<string, string> = {
    'email': email,
    'metadata[rider_id]': riderId,
    'metadata[platform]': 'takeme',
  };
  if (name) params['name'] = name;

  const customer = await stripeRequest('/customers', params);
  return customer.id as string;
}

// ── Payment Intent ───────────────────────────────────────────────────────

export interface CreatePaymentIntentParams {
  amount: number;         // in smallest currency unit (cents)
  currency: string;
  customerId: string;
  rideId: string;
  description?: string;
  savedPaymentMethodId?: string;  // if rider has a saved card
}

export interface PaymentIntentResult {
  id: string;
  clientSecret: string;
  status: string;
}

export async function createPaymentIntent(
  params: CreatePaymentIntentParams,
): Promise<PaymentIntentResult> {
  const body: Record<string, string> = {
    'amount': String(params.amount),
    'currency': params.currency.toLowerCase(),
    'customer': params.customerId,
    'capture_method': 'manual',  // authorize now, capture after ride completes
    'automatic_payment_methods[enabled]': 'true',
    'metadata[ride_id]': params.rideId,
    'metadata[platform]': 'takeme',
  };

  if (params.description) body['description'] = params.description;

  if (params.savedPaymentMethodId) {
    body['payment_method'] = params.savedPaymentMethodId;
    body['confirm'] = 'true';
  }

  // Idempotency key: ride-specific, prevents duplicate intents on retry
  const idempotencyKey = `pi_${params.rideId}_${params.amount}`;
  const data = await stripeRequest('/payment_intents', body, 'POST', idempotencyKey);
  return {
    id: data.id as string,
    clientSecret: data.client_secret as string,
    status: data.status as string,
  };
}

// ── Checkout Session ─────────────────────────────────────────────────────

export interface CreateCheckoutParams {
  rideId: string;
  amount: number;        // in cents
  currency: string;
  customerEmail?: string;
  successUrl: string;
  cancelUrl: string;
}

export async function createCheckoutSession(params: CreateCheckoutParams): Promise<{
  id: string;
  url: string;
}> {
  const body: Record<string, string> = {
    'mode': 'payment',
    'line_items[0][price_data][currency]': params.currency.toLowerCase(),
    'line_items[0][price_data][unit_amount]': String(params.amount),
    'line_items[0][price_data][product_data][name]': 'TakeMe Ride',
    'line_items[0][price_data][product_data][description]': `Ride #${params.rideId.slice(0, 8)}`,
    'line_items[0][quantity]': '1',
    'metadata[ride_id]': params.rideId,
    'success_url': params.successUrl,
    'cancel_url': params.cancelUrl,
  };
  if (params.customerEmail) {
    body['customer_email'] = params.customerEmail;
  }

  const idempotencyKey = `checkout_${params.rideId}`;
  const data = await stripeRequest('/checkout/sessions', body, 'POST', idempotencyKey);
  return {
    id: data.id as string,
    url: data.url as string,
  };
}

// ── Capture (after ride completes) ───────────────────────────────────────

export async function capturePaymentIntent(
  paymentIntentId: string,
  amountToCapture?: number,
): Promise<{ id: string; status: string }> {
  const params: Record<string, string> = {};
  if (amountToCapture !== undefined) {
    params['amount_to_capture'] = String(amountToCapture);
  }
  const data = await stripeRequest(`/payment_intents/${paymentIntentId}/capture`, params);
  return { id: data.id as string, status: data.status as string };
}

// ── Cancel PaymentIntent ─────────────────────────────────────────────────

export async function cancelPaymentIntent(
  paymentIntentId: string,
  reason?: string,
): Promise<{ id: string; status: string }> {
  const params: Record<string, string> = {};
  if (reason) params['cancellation_reason'] = reason;
  const data = await stripeRequest(`/payment_intents/${paymentIntentId}/cancel`, params);
  return { id: data.id as string, status: data.status as string };
}

// ── Refund ───────────────────────────────────────────────────────────────

export async function createRefund(
  paymentIntentId: string,
  amount?: number,
  reason?: string,
): Promise<{ id: string; status: string }> {
  const params: Record<string, string> = {
    'payment_intent': paymentIntentId,
  };
  if (amount) params['amount'] = String(amount);
  if (reason) params['reason'] = reason;

  const data = await stripeRequest('/refunds', params);
  return { id: data.id as string, status: data.status as string };
}

// ── Webhook signature verification ───────────────────────────────────────

export async function verifyWebhookSignature(
  payload: string,
  signature: string,
): Promise<Record<string, unknown>> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET not configured');

  // Stripe webhook signature uses HMAC-SHA256
  const crypto = await import('crypto');
  const parts = signature.split(',');
  const timestamp = parts.find(p => p.startsWith('t='))?.slice(2);
  const sig = parts.find(p => p.startsWith('v1='))?.slice(3);

  if (!timestamp || !sig) throw new Error('Invalid signature format');

  const signedPayload = `${timestamp}.${payload}`;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(signedPayload)
    .digest('hex');

  // Constant-time comparison — avoids a timing side-channel on the HMAC.
  const sigBuf = Buffer.from(sig, 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    throw new Error('Webhook signature verification failed');
  }

  // Check timestamp tolerance (5 min)
  const age = Math.floor(Date.now() / 1000) - parseInt(timestamp);
  if (age > 300) throw new Error('Webhook timestamp too old');

  return JSON.parse(payload);
}
