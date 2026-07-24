// ═══════════════════════════════════════════════════════════════════════════
// Driver payout policy — pure, dependency-free, unit-tested.
// Fee math, quoting, and request validation. The execution engine
// (lib/driver-payouts.ts) composes these with fresh server-side state;
// nothing here ever trusts a client-supplied balance.
// ═══════════════════════════════════════════════════════════════════════════

export interface PayoutConfig {
  /** Instant payout fee, fraction of amount (default 1.5%). */
  instantFeePct: number;
  /** Instant payout minimum fee in USD (default $0.50). */
  instantFeeMinUsd: number;
  /** Minimum payout amount in USD. */
  minPayoutUsd: number;
  /** Rolling 24h payout cap in USD (fraud control — disclosed, never silent). */
  dailyLimitUsd: number;
}

export function payoutConfigFromEnv(env: Record<string, string | undefined> = process.env): PayoutConfig {
  const num = (v: string | undefined, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    instantFeePct: num(env.INSTANT_PAYOUT_FEE_PCT, 0.015),
    instantFeeMinUsd: num(env.INSTANT_PAYOUT_FEE_MIN_USD, 0.5),
    minPayoutUsd: num(env.PAYOUT_MIN_USD, 1),
    dailyLimitUsd: num(env.PAYOUT_DAILY_LIMIT_USD, 500),
  };
}

/** Round to cents, away from floating-point dust. */
export function toCents(usd: number): number {
  return Math.round(usd * 100);
}

export function centsToUsd(cents: number): number {
  return Math.round(cents) / 100;
}

/** Instant fee in USD for a requested amount; standard payouts are free. */
export function instantFeeUsd(amountUsd: number, config: PayoutConfig): number {
  const pct = amountUsd * config.instantFeePct;
  return centsToUsd(toCents(Math.max(pct, config.instantFeeMinUsd)));
}

export interface PayoutQuote {
  amountUsd: number;
  feeUsd: number;
  netUsd: number;
  speed: 'instant' | 'standard';
}

export function quotePayout(
  amountUsd: number,
  speed: 'instant' | 'standard',
  config: PayoutConfig,
): PayoutQuote {
  const feeUsd = speed === 'instant' ? instantFeeUsd(amountUsd, config) : 0;
  return {
    amountUsd: centsToUsd(toCents(amountUsd)),
    feeUsd,
    netUsd: centsToUsd(toCents(amountUsd) - toCents(feeUsd)),
    speed,
  };
}

export type PayoutRejection =
  | { ok: false; code: 'BELOW_MINIMUM'; message: string }
  | { ok: false; code: 'INSUFFICIENT_AVAILABLE'; message: string }
  | { ok: false; code: 'DAILY_LIMIT'; message: string }
  | { ok: false; code: 'FEE_EXCEEDS_AMOUNT'; message: string };

/** Pure validation of a payout request against server-derived state. */
export function validatePayoutRequest(input: {
  amountUsd: number;
  availableUsd: number;
  paidOutLast24hUsd: number;
  quote: PayoutQuote;
  config: PayoutConfig;
}): { ok: true } | PayoutRejection {
  const { amountUsd, availableUsd, paidOutLast24hUsd, quote, config } = input;
  if (!(amountUsd > 0) || toCents(amountUsd) < toCents(config.minPayoutUsd)) {
    return {
      ok: false,
      code: 'BELOW_MINIMUM',
      message: `Minimum payout is $${config.minPayoutUsd.toFixed(2)}.`,
    };
  }
  if (toCents(amountUsd) > toCents(availableUsd)) {
    return {
      ok: false,
      code: 'INSUFFICIENT_AVAILABLE',
      message: 'Amount exceeds your available balance.',
    };
  }
  if (quote.netUsd <= 0) {
    return {
      ok: false,
      code: 'FEE_EXCEEDS_AMOUNT',
      message: 'Amount is too small to cover the instant payout fee.',
    };
  }
  if (toCents(paidOutLast24hUsd) + toCents(amountUsd) > toCents(config.dailyLimitUsd)) {
    return {
      ok: false,
      code: 'DAILY_LIMIT',
      message: `Payouts are limited to $${config.dailyLimitUsd.toFixed(2)} per 24 hours.`,
    };
  }
  return { ok: true };
}

/** Driver-safe failure copy — Stripe messages can leak internals. */
export function sanitizeStripeFailure(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();
  if (lower.includes('insufficient funds') || lower.includes('insufficient available')) {
    // Platform balance shortfall — not the driver's fault, never their wording.
    return 'Payouts are temporarily unavailable. Try again shortly.';
  }
  if (lower.includes('instant')) {
    return 'Instant payout is unavailable for this destination right now.';
  }
  if (lower.includes('card') || lower.includes('bank')) {
    return 'Your payout destination could not accept this payout.';
  }
  return 'The payout could not be completed.';
}
