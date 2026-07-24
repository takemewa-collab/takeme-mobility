// ═══════════════════════════════════════════════════════════════════════════
// TAKEME Card (Stripe Issuing) — pure settlement math.
// Kept free of I/O so the webhook's money math is unit-testable; the atomic
// DB mutation lives in the apply_issuing_transaction RPC (migration 053).
// ═══════════════════════════════════════════════════════════════════════════

export interface CashbackRates {
  /** Percent values as stored on takeme_cards, e.g. 3 for 3%. */
  ev: number;
  gas: number;
  other: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Category → rate fraction. EV charging is matched BEFORE generic fuel:
 * Stripe's `fuel_electric`-style categories contain "fuel" too and must get
 * the EV rate.
 */
export function cashbackRateFor(category: string | null | undefined, rates: CashbackRates): number {
  const c = (category ?? '').toLowerCase();
  if (c.includes('electric')) return rates.ev / 100;
  if (c.includes('fuel') || c.includes('gas')) return rates.gas / 100;
  return rates.other / 100;
}

/** Cashback in dollars, rounded to cents. Never negative. */
export function computeCashback(
  amountDollars: number,
  category: string | null | undefined,
  rates: CashbackRates,
): number {
  if (!(amountDollars > 0)) return 0;
  return Math.max(0, round2(amountDollars * cashbackRateFor(category, rates)));
}

/** Stripe Issuing amounts are signed integer cents; settle on magnitude. */
export function issuingAmountDollars(amountCents: number | null | undefined): number {
  const cents = Math.abs(Number(amountCents ?? 0));
  return Number.isFinite(cents) ? round2(cents / 100) : 0;
}
