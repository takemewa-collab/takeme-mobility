import { describe, expect, it } from 'vitest';
import {
  instantFeeUsd,
  payoutConfigFromEnv,
  quotePayout,
  sanitizeStripeFailure,
  toCents,
  validatePayoutRequest,
} from '../driver-payout-policy';

const config = payoutConfigFromEnv({});

describe('payoutConfigFromEnv', () => {
  it('defaults: 1.5% instant fee, $0.50 min fee, $1 min payout, $500/day cap', () => {
    expect(config).toEqual({
      instantFeePct: 0.015,
      instantFeeMinUsd: 0.5,
      minPayoutUsd: 1,
      dailyLimitUsd: 500,
    });
  });

  it('reads overrides and ignores garbage', () => {
    const c = payoutConfigFromEnv({
      INSTANT_PAYOUT_FEE_PCT: '0.01',
      INSTANT_PAYOUT_FEE_MIN_USD: 'not-a-number',
      PAYOUT_DAILY_LIMIT_USD: '1000',
    });
    expect(c.instantFeePct).toBe(0.01);
    expect(c.instantFeeMinUsd).toBe(0.5);
    expect(c.dailyLimitUsd).toBe(1000);
  });
});

describe('instant fee', () => {
  it('applies the minimum fee to small amounts', () => {
    // 1.5% of $7.69 = $0.115 → below the $0.50 floor.
    expect(instantFeeUsd(7.69, config)).toBe(0.5);
  });

  it('applies the percentage above the floor, rounded to cents', () => {
    expect(instantFeeUsd(100, config)).toBe(1.5);
    expect(instantFeeUsd(53.33, config)).toBe(0.8); // 0.79995 → 80¢
  });

  it('standard payouts are free', () => {
    const q = quotePayout(50, 'standard', config);
    expect(q.feeUsd).toBe(0);
    expect(q.netUsd).toBe(50);
  });

  it('net = amount − fee, exact in cents', () => {
    const q = quotePayout(7.69, 'instant', config);
    expect(q.feeUsd).toBe(0.5);
    expect(q.netUsd).toBe(7.19);
    expect(toCents(q.netUsd) + toCents(q.feeUsd)).toBe(toCents(q.amountUsd));
  });
});

describe('validatePayoutRequest', () => {
  const base = {
    availableUsd: 100,
    paidOutLast24hUsd: 0,
    config,
  };

  it('accepts a normal request', () => {
    const quote = quotePayout(50, 'instant', config);
    expect(validatePayoutRequest({ ...base, amountUsd: 50, quote })).toEqual({ ok: true });
  });

  it('rejects below the minimum', () => {
    const quote = quotePayout(0.75, 'standard', config);
    const r = validatePayoutRequest({ ...base, amountUsd: 0.75, quote });
    expect(r).toMatchObject({ ok: false, code: 'BELOW_MINIMUM' });
  });

  it('rejects more than the available balance — pending is never withdrawable', () => {
    const quote = quotePayout(100.01, 'standard', config);
    const r = validatePayoutRequest({ ...base, amountUsd: 100.01, quote });
    expect(r).toMatchObject({ ok: false, code: 'INSUFFICIENT_AVAILABLE' });
  });

  it('rejects when the fee would consume the whole amount', () => {
    // $1 minimum passes, but $0.50 fee on $1.00 leaves net $0.50 — fine;
    // force the degenerate case with a huge configured fee.
    const greedy = { ...config, instantFeeMinUsd: 2 };
    const quote = quotePayout(1, 'instant', greedy);
    const r = validatePayoutRequest({ ...base, amountUsd: 1, quote, config: greedy });
    expect(r).toMatchObject({ ok: false, code: 'FEE_EXCEEDS_AMOUNT' });
  });

  it('enforces the disclosed rolling daily limit', () => {
    const quote = quotePayout(200, 'instant', config);
    const r = validatePayoutRequest({
      ...base,
      amountUsd: 200,
      paidOutLast24hUsd: 400,
      availableUsd: 1000,
      quote,
    });
    expect(r).toMatchObject({ ok: false, code: 'DAILY_LIMIT' });
  });

  it('exact-cent boundary: paying out the full available balance is allowed', () => {
    const quote = quotePayout(100, 'instant', config);
    expect(validatePayoutRequest({ ...base, amountUsd: 100, quote })).toEqual({ ok: true });
  });
});

describe('sanitizeStripeFailure', () => {
  it('never blames the driver for a platform balance shortfall', () => {
    const msg = sanitizeStripeFailure(new Error('You have insufficient funds in your Stripe account.'));
    expect(msg).toBe('Payouts are temporarily unavailable. Try again shortly.');
    expect(msg.toLowerCase()).not.toContain('insufficient');
  });

  it('maps instant-capability failures to actionable copy', () => {
    expect(sanitizeStripeFailure(new Error('Instant payouts are not supported for this card.'))).toContain(
      'Instant payout is unavailable',
    );
  });

  it('falls back to neutral copy', () => {
    expect(sanitizeStripeFailure(new Error('internal secret detail'))).toBe(
      'The payout could not be completed.',
    );
  });
});
