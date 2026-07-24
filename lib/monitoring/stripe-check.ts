// ═══════════════════════════════════════════════════════════════════════════
// Stripe connectivity check for the synthetic E2E monitor.
//
// LIVE keys must never fabricate Stripe objects: the every-5-minutes cron was
// creating and cancelling a real $1 PaymentIntent in live mode once the
// production key went live — synthetic traffic in live logs/Radar that can
// read as card-testing. With a live key the check is a READ-ONLY
// authenticated request (GET /v1/balance). The create-and-cancel cycle is
// kept exclusively for explicit test keys (sk_test_...); any other prefix
// (live, restricted, unknown) gets the read-only path — fail safe.
// ═══════════════════════════════════════════════════════════════════════════

export type StripeCheckMode = 'live_readonly' | 'test_synthetic';

export function stripeCheckModeFor(key: string): StripeCheckMode {
  return key.startsWith('sk_test_') ? 'test_synthetic' : 'live_readonly';
}

export interface StripeCheckResult {
  mode: StripeCheckMode;
}

/**
 * Runs the mode-appropriate Stripe health check. Throws on any failure.
 * `fetchFn` is injectable for tests — no secrets or network in the suite.
 */
export async function runStripeCheck(
  key: string,
  fetchFn: typeof fetch = fetch,
): Promise<StripeCheckResult> {
  if (!key) throw new Error('STRIPE_SECRET_KEY not set');

  if (stripeCheckModeFor(key) === 'live_readonly') {
    // Read-only authenticated probe — proves key validity + API reachability
    // without creating, mutating, or cancelling anything.
    const res = await fetchFn('https://api.stripe.com/v1/balance', {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) throw new Error(`Balance: HTTP ${res.status}`);
    return { mode: 'live_readonly' };
  }

  // Test-mode synthetic cycle (unchanged): create a minimal $1 intent, then
  // cancel it immediately.
  const createRes = await fetchFn('https://api.stripe.com/v1/payment_intents', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'amount=100&currency=usd&metadata[test]=e2e_monitor',
  });
  if (!createRes.ok) throw new Error(`Create: HTTP ${createRes.status}`);
  const pi = (await createRes.json()) as { id: string };

  const cancelRes = await fetchFn(`https://api.stripe.com/v1/payment_intents/${pi.id}/cancel`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!cancelRes.ok) throw new Error(`Cancel: HTTP ${cancelRes.status}`);

  return { mode: 'test_synthetic' };
}
