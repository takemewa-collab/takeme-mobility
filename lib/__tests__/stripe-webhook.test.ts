import { describe, expect, it } from 'vitest';
import Stripe from 'stripe';
import { WEBHOOK_TOLERANCE_SEC, verifyStripeSignature } from '../stripe-webhook';

// Dummy signing secrets for tests only — never real credentials.
const CURRENT_SECRET = 'whsec_test_current_secret_0000000000';
const RETIRED_SECRET = 'whsec_test_retired_secret_0000000000';

const payload = JSON.stringify({
  id: 'evt_test_1',
  type: 'payment_intent.succeeded',
  data: { object: { id: 'pi_test_1' } },
});

const nowSec = () => Math.floor(Date.now() / 1000);

/** `t=...,v1=...` header signed with `secret` at `timestamp`. */
function signedHeader(secret: string, timestamp: number, body: string = payload): string {
  return Stripe.webhooks.generateTestHeaderString({ payload: body, secret, timestamp });
}

/** Extract the v1 value from a generated header. */
function v1Of(header: string): string {
  const m = /(?:^|,)v1=([0-9a-f]+)/.exec(header);
  if (!m) throw new Error('no v1 in test header');
  return m[1];
}

describe('verifyStripeSignature', () => {
  it('accepts a valid, fresh signature and returns the parsed event', () => {
    const header = signedHeader(CURRENT_SECRET, nowSec());
    const event = verifyStripeSignature(payload, header, CURRENT_SECRET);
    expect(event.id).toBe('evt_test_1');
    expect(event.type).toBe('payment_intent.succeeded');
  });

  it('accepts a header with multiple v1 signatures when ANY matches (secret rotation), even if the first does not', () => {
    const ts = nowSec();
    const oldV1 = v1Of(signedHeader(RETIRED_SECRET, ts));
    const newV1 = v1Of(signedHeader(CURRENT_SECRET, ts));
    // Stripe orders signatures arbitrarily during rotation — put the
    // non-matching one FIRST to prove verification is not first-v1-only.
    const header = `t=${ts},v1=${oldV1},v1=${newV1}`;
    const event = verifyStripeSignature(payload, header, CURRENT_SECRET);
    expect(event.id).toBe('evt_test_1');
  });

  it('rejects when every v1 signature is from a different (rotated-away) secret', () => {
    const header = signedHeader(RETIRED_SECRET, nowSec());
    expect(() => verifyStripeSignature(payload, header, CURRENT_SECRET)).toThrow();
  });

  it('rejects an invalid signature', () => {
    const ts = nowSec();
    const header = `t=${ts},v1=${'ab'.repeat(32)}`;
    expect(() => verifyStripeSignature(payload, header, CURRENT_SECRET)).toThrow();
  });

  it('rejects a tampered payload', () => {
    const header = signedHeader(CURRENT_SECRET, nowSec());
    const tampered = payload.replace('pi_test_1', 'pi_evil_9');
    expect(() => verifyStripeSignature(tampered, header, CURRENT_SECRET)).toThrow();
  });

  it('rejects a stale timestamp (older than the tolerance)', () => {
    const ts = nowSec() - (WEBHOOK_TOLERANCE_SEC + 60);
    const header = signedHeader(CURRENT_SECRET, ts);
    expect(() => verifyStripeSignature(payload, header, CURRENT_SECRET)).toThrow();
  });

  it('rejects a timestamp materially in the future', () => {
    const ts = nowSec() + WEBHOOK_TOLERANCE_SEC + 60;
    const header = signedHeader(CURRENT_SECRET, ts);
    expect(() => verifyStripeSignature(payload, header, CURRENT_SECRET)).toThrow(/future/i);
  });

  it('accepts a slightly-future timestamp inside the tolerance (clock skew)', () => {
    const ts = nowSec() + 60;
    const header = signedHeader(CURRENT_SECRET, ts);
    const event = verifyStripeSignature(payload, header, CURRENT_SECRET);
    expect(event.id).toBe('evt_test_1');
  });

  it('rejects a header with no timestamp', () => {
    const header = `v1=${v1Of(signedHeader(CURRENT_SECRET, nowSec()))}`;
    expect(() => verifyStripeSignature(payload, header, CURRENT_SECRET)).toThrow(/timestamp/i);
  });

  it('rejects a missing header or missing secret', () => {
    expect(() => verifyStripeSignature(payload, '', CURRENT_SECRET)).toThrow();
    const header = signedHeader(CURRENT_SECRET, nowSec());
    expect(() => verifyStripeSignature(payload, header, '')).toThrow();
  });
});
