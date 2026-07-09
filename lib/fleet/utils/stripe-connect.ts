// ═══════════════════════════════════════════════════════════════════════════
// TakeMe Fleet — Stripe Connect helpers
// Uses REST API directly to match existing lib/stripe.ts pattern
// ═══════════════════════════════════════════════════════════════════════════

const STRIPE_API = 'https://api.stripe.com/v1'

function getSecretKey(): string {
  const key = process.env.STRIPE_SECRET_KEY ?? ''
  if (!key || key.includes('PASTE_YOUR')) throw new Error('STRIPE_SECRET_KEY is not configured')
  return key
}

async function stripePost(path: string, params: Record<string, string>, idempotencyKey?: string): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${getSecretKey()}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  }
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey

  const res = await fetch(`${STRIPE_API}${path}`, {
    method: 'POST',
    headers,
    body: new URLSearchParams(params).toString(),
  })
  const data = await res.json()
  if (!res.ok) {
    const msg = (data as { error?: { message?: string } })?.error?.message || `Stripe error ${res.status}`
    throw new Error(msg)
  }
  return data
}

async function stripeGet(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${getSecretKey()}` },
  })
  const data = await res.json()
  if (!res.ok) {
    const msg = (data as { error?: { message?: string } })?.error?.message || `Stripe error ${res.status}`
    throw new Error(msg)
  }
  return data
}

// ── Stripe Connect (Fleet Owner Onboarding) ─────────────────────────────

export async function createConnectedAccount(params: {
  email: string
  businessType: string
  ownerId: string
}): Promise<{ accountId: string }> {
  const body: Record<string, string> = {
    type: 'express',
    country: 'US',
    email: params.email,
    'capabilities[transfers][requested]': 'true',
    'capabilities[card_payments][requested]': 'true',
    'metadata[fleet_owner_id]': params.ownerId,
    'metadata[platform]': 'takeme_fleet',
    'business_type': params.businessType === 'individual' ? 'individual' : 'company',
  }
  const data = await stripePost('/accounts', body, `fleet_account_${params.ownerId}`)
  return { accountId: data.id as string }
}

export async function createAccountLink(accountId: string, returnUrl: string, refreshUrl: string): Promise<{ url: string }> {
  const data = await stripePost('/account_links', {
    account: accountId,
    type: 'account_onboarding',
    return_url: returnUrl,
    refresh_url: refreshUrl,
  })
  return { url: data.url as string }
}

export async function getConnectedAccount(accountId: string): Promise<{
  detailsSubmitted: boolean
  payoutsEnabled: boolean
  chargesEnabled: boolean
}> {
  const data = await stripeGet(`/accounts/${accountId}`)
  return {
    detailsSubmitted: data.details_submitted as boolean,
    payoutsEnabled: data.payouts_enabled as boolean,
    chargesEnabled: data.charges_enabled as boolean,
  }
}

// ── Stripe Identity (KYC) ───────────────────────────────────────────────

export async function createVerificationSession(params: {
  ownerId: string
  returnUrl: string
}): Promise<{ sessionId: string; url: string }> {
  const data = await stripePost('/identity/verification_sessions', {
    type: 'document',
    'metadata[fleet_owner_id]': params.ownerId,
    'metadata[platform]': 'takeme_fleet',
    'options[document][require_matching_selfie]': 'true',
    return_url: params.returnUrl,
  })
  return { sessionId: data.id as string, url: data.url as string }
}

export async function getVerificationSession(sessionId: string): Promise<{
  status: string
  lastError?: { code: string; reason: string }
}> {
  const data = await stripeGet(`/identity/verification_sessions/${sessionId}`)
  const lastError = data.last_error as { code?: string; reason?: string } | null
  return {
    status: data.status as string,
    lastError: lastError ? { code: lastError.code ?? '', reason: lastError.reason ?? '' } : undefined,
  }
}

// ── Stripe Connect Transfers (Payouts to Owners) ────────────────────────

export async function createTransfer(params: {
  amount: number
  destinationAccountId: string
  transferGroup: string
  bookingId: string
  description?: string
}): Promise<{ transferId: string }> {
  const body: Record<string, string> = {
    amount: String(params.amount),
    currency: 'usd',
    destination: params.destinationAccountId,
    transfer_group: params.transferGroup,
    'metadata[booking_id]': params.bookingId,
    'metadata[platform]': 'takeme_fleet',
  }
  if (params.description) body.description = params.description
  const data = await stripePost('/transfers', body, `fleet_transfer_${params.bookingId}`)
  return { transferId: data.id as string }
}

// ── Payment Intents for Fleet ───────────────────────────────────────────

export async function createFleetPaymentIntent(params: {
  amount: number
  customerId?: string
  bookingId: string
  description: string
  paymentMethodId?: string
  captureMethod?: 'automatic' | 'manual'
  transferGroup?: string
}): Promise<{ id: string; clientSecret: string; status: string }> {
  const body: Record<string, string> = {
    amount: String(params.amount),
    currency: 'usd',
    'automatic_payment_methods[enabled]': 'true',
    'metadata[booking_id]': params.bookingId,
    'metadata[type]': 'fleet_rental',
    'metadata[platform]': 'takeme_fleet',
    description: params.description,
    capture_method: params.captureMethod ?? 'automatic',
  }
  if (params.customerId) body.customer = params.customerId
  if (params.paymentMethodId) {
    body.payment_method = params.paymentMethodId
    body.confirm = 'true'
  }
  if (params.transferGroup) body.transfer_group = params.transferGroup

  const data = await stripePost('/payment_intents', body, `fleet_pi_${params.bookingId}`)
  return {
    id: data.id as string,
    clientSecret: data.client_secret as string,
    status: data.status as string,
  }
}

export async function cancelFleetPaymentIntent(paymentIntentId: string): Promise<void> {
  await stripePost(`/payment_intents/${paymentIntentId}/cancel`, {})
}

export async function createFleetRefund(paymentIntentId: string, amount?: number): Promise<{ refundId: string }> {
  const body: Record<string, string> = { payment_intent: paymentIntentId }
  if (amount) body.amount = String(amount)
  const data = await stripePost('/refunds', body)
  return { refundId: data.id as string }
}

// ── Webhook Signature Verification ──────────────────────────────────────

export async function verifyFleetWebhookSignature(payload: string, signature: string): Promise<Record<string, unknown>> {
  const secret = process.env.STRIPE_FLEET_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET
  if (!secret) throw new Error('Fleet webhook secret not configured')

  const crypto = await import('crypto')
  const parts = signature.split(',')
  const timestamp = parts.find(p => p.startsWith('t='))?.slice(2)
  const sig = parts.find(p => p.startsWith('v1='))?.slice(3)

  if (!timestamp || !sig) throw new Error('Invalid signature format')

  const signedPayload = `${timestamp}.${payload}`
  const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex')

  // Constant-time comparison — avoids a timing side-channel on the HMAC.
  const sigBuf = Buffer.from(sig, 'hex')
  const expBuf = Buffer.from(expected, 'hex')
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    throw new Error('Webhook signature verification failed')
  }

  const age = Math.floor(Date.now() / 1000) - parseInt(timestamp)
  if (age > 300) throw new Error('Webhook timestamp too old')

  return JSON.parse(payload)
}
