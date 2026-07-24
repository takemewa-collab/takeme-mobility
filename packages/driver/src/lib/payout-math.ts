/**
 * Client-side payout arithmetic — DISPLAY ONLY. The server recomputes every
 * fee and eligibility decision at execution time; these helpers exist so the
 * cash-out sheet can show the driver an honest preview of the same policy
 * (max(minimum fee, amount x pct), rounded to cents) before they confirm.
 */

export function roundCents(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Instant payout fee preview: max(minimum, pct of amount), in cents. */
export function instantFeeUsd(amountUsd: number, feePct: number, feeMinUsd: number): number {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) return 0;
  return roundCents(Math.max(feeMinUsd, amountUsd * feePct));
}

/** What actually lands in the driver's account for a given speed. */
export function netPayoutUsd(
  amountUsd: number,
  speed: 'instant' | 'standard',
  fees: { instantFeePct: number; instantFeeMinUsd: number; standardFeeUsd: number },
): number {
  const fee =
    speed === 'instant'
      ? instantFeeUsd(amountUsd, fees.instantFeePct, fees.instantFeeMinUsd)
      : roundCents(fees.standardFeeUsd);
  return roundCents(Math.max(0, amountUsd - fee));
}

/**
 * Parse the free-form amount field. Accepts "25", "25.5", "25.50", with an
 * optional leading "$" and stray whitespace. Returns null for anything that
 * is not a positive dollar amount with at most two decimals.
 */
export function parseAmountInput(text: string): number | null {
  const cleaned = text.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value <= 0) return null;
  return roundCents(value);
}

export type CashOutAmountIssue = 'invalid' | 'below_minimum' | 'exceeds_available' | null;

/**
 * Client-side sanity check before enabling the confirm button. The server is
 * still the authority — this only prevents obviously-doomed requests.
 */
export function validateCashOutAmount(
  amountUsd: number | null,
  availableUsd: number,
  minPayoutUsd: number,
): CashOutAmountIssue {
  if (amountUsd == null || !Number.isFinite(amountUsd) || amountUsd <= 0) return 'invalid';
  if (amountUsd > availableUsd) return 'exceeds_available';
  if (amountUsd < minPayoutUsd) return 'below_minimum';
  return null;
}
