// ═══════════════════════════════════════════════════════════════════════════
// Stripe webhook signature verification.
//
// Uses the OFFICIAL stripe-node verifier (Stripe.webhooks.constructEvent):
// it parses the Stripe-Signature header, compares the HMAC-SHA256 of
// `t.rawBody` against EVERY `v1` signature in the header (constant-time),
// so rotated secrets — where Stripe signs with both the old and new secret —
// keep verifying, and rejects payloads older than the tolerance.
//
// constructEvent does NOT reject timestamps from the future (its check is
// `now - t > tolerance`, which a future `t` always passes), so a clock-skewed
// or replayed-with-forged-t request is additionally rejected here when `t`
// is materially ahead of server time.
//
// This module is dependency-light and pure enough to unit test: the caller
// supplies the secret; env access stays in lib/stripe.ts.
// ═══════════════════════════════════════════════════════════════════════════
import Stripe from 'stripe';

/** Symmetric acceptance window for the signed timestamp, in seconds. */
export const WEBHOOK_TOLERANCE_SEC = 300;

/**
 * Verifies `payload` (the RAW request body string — never a re-serialized
 * parse) against the Stripe-Signature header. Returns the parsed event.
 * Throws on any failure: missing/malformed header, no matching v1 signature,
 * stale timestamp, or future timestamp.
 */
export function verifyStripeSignature(
  payload: string,
  signatureHeader: string,
  secret: string,
  nowMs: number = Date.now(),
): Record<string, unknown> {
  if (!secret) throw new Error('Webhook secret not provided');
  if (!signatureHeader) throw new Error('Missing Stripe-Signature header');

  // Reject future timestamps first — the official verifier only checks
  // staleness. "Materially in the future" = beyond the same tolerance.
  const timestampMatch = /(?:^|,)\s*t=(\d+)(?:,|$)/.exec(signatureHeader);
  const signedAt = Number(timestampMatch?.[1]);
  if (!Number.isFinite(signedAt)) {
    throw new Error('Invalid Stripe-Signature header: missing timestamp');
  }
  const nowSec = Math.floor(nowMs / 1000);
  if (signedAt - nowSec > WEBHOOK_TOLERANCE_SEC) {
    throw new Error('Webhook timestamp is in the future');
  }

  // Official verification: every v1 signature, constant-time comparison,
  // staleness enforced via the tolerance argument.
  const event = Stripe.webhooks.constructEvent(
    payload,
    signatureHeader,
    secret,
    WEBHOOK_TOLERANCE_SEC,
  );
  return event as unknown as Record<string, unknown>;
}
