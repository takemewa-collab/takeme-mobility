// ═══════════════════════════════════════════════════════════════════════════
// Driver earnings reporting — pure, timezone-correct aggregation over the
// immutable driver_transactions ledger. No fabrication: every number is a
// sum of ledger rows; online hours come only from driver_status_history and
// are null (never zero) when no history exists for the window.
// ═══════════════════════════════════════════════════════════════════════════

export interface LedgerRow {
  type: string; // ride_earning | tip | bonus | payout | card_fund | card_cashback | adjustment | fee
  amount: number | string;
  ride_id?: string | null;
  created_at: string;
}

export interface StatusHistoryRow {
  status: string; // offline | available | busy | on_trip
  effective_at: string;
}

/** Local calendar date (YYYY-MM-DD) of an instant in an IANA timezone. */
export function localDate(isoInstant: string | Date, timeZone: string): string {
  const d = typeof isoInstant === 'string' ? new Date(isoInstant) : isoInstant;
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(d); // en-CA gives YYYY-MM-DD
}

/**
 * The UTC instant at which a local calendar date starts in `timeZone`.
 * Iterative (DST-safe): finds the UTC ms where local date flips to `date`.
 */
export function startOfLocalDay(date: string, timeZone: string): Date {
  // Start from noon UTC of that date (always inside the right local day ±1)
  // and walk back hour-by-hour until the local date changes.
  let t = Date.parse(`${date}T12:00:00Z`);
  while (localDate(new Date(t), timeZone) === date) t -= 3600_000;
  // t is now in the previous local day; walk forward minute-by-minute.
  while (localDate(new Date(t), timeZone) !== date) t += 60_000;
  return new Date(t);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Monday-start week containing `date` (local calendar). */
export function weekBounds(date: string): { start: string; end: string; days: string[] } {
  const d = new Date(`${date}T12:00:00Z`);
  const dow = d.getUTCDay(); // 0=Sun
  const back = dow === 0 ? 6 : dow - 1;
  const start = addDays(date, -back);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  return { start, end: days[6], days };
}

const EARNING_TYPES = new Set(['ride_earning', 'tip', 'bonus']);

export interface EarningsSummary {
  grossUsd: number;
  rideEarningsUsd: number;
  tipsUsd: number;
  bonusesUsd: number;
  adjustmentsUsd: number;
  feesUsd: number;
  netUsd: number;
  trips: number;
}

/**
 * Summarize ledger rows into the driver-facing gross/net breakdown.
 * Payout/card movements are balance transfers, not earnings — excluded.
 * Adjustments EXCLUDE payout-failure returns (those reverse a withdrawal,
 * not earn money): callers pass rows already filtered to the window.
 */
export function summarizeEarnings(rows: LedgerRow[]): EarningsSummary {
  let ride = 0;
  let tips = 0;
  let bonuses = 0;
  let adjustments = 0;
  let fees = 0;
  const rideIds = new Set<string>();
  for (const row of rows) {
    const amount = Number(row.amount);
    if (!Number.isFinite(amount)) continue;
    switch (row.type) {
      case 'ride_earning':
        ride += amount;
        if (row.ride_id) rideIds.add(row.ride_id);
        break;
      case 'tip':
        tips += amount;
        break;
      case 'bonus':
        bonuses += amount;
        break;
      case 'adjustment':
        adjustments += amount;
        break;
      case 'fee':
        fees += amount; // stored negative
        break;
      default:
        break; // payout / card_fund / card_cashback are transfers
    }
  }
  const round = (n: number) => Math.round(n * 100) / 100;
  const gross = ride + tips + bonuses;
  return {
    grossUsd: round(gross),
    rideEarningsUsd: round(ride),
    tipsUsd: round(tips),
    bonusesUsd: round(bonuses),
    adjustmentsUsd: round(adjustments),
    feesUsd: round(fees),
    netUsd: round(gross + adjustments + fees),
    trips: rideIds.size,
  };
}

/** Adjustment rows that merely return failed payouts — not earnings. */
export function isPayoutReturn(row: LedgerRow & { description?: string | null }): boolean {
  return row.type === 'adjustment' && (row.description ?? '').toLowerCase().includes('payout failed');
}

export interface DayBucket {
  date: string;
  earnings: EarningsSummary;
}

export function bucketByLocalDay(rows: LedgerRow[], days: string[], timeZone: string): DayBucket[] {
  const byDay = new Map<string, LedgerRow[]>(days.map((d) => [d, []]));
  for (const row of rows) {
    const day = localDate(row.created_at, timeZone);
    byDay.get(day)?.push(row);
  }
  return days.map((date) => ({ date, earnings: summarizeEarnings(byDay.get(date) ?? []) }));
}

/**
 * Online seconds within [from, to) from status-history transitions.
 * Rows must be ordered ascending and include (when available) the last
 * transition BEFORE the window so the opening state is known.
 * Returns null when there is no history at all — online time simply was not
 * being recorded yet; the UI must show an empty state, never a fake 0.
 */
export function onlineSeconds(
  rows: StatusHistoryRow[],
  from: Date,
  to: Date,
  now: Date = new Date(),
): number | null {
  if (rows.length === 0) return null;
  const cutoff = Math.min(to.getTime(), now.getTime());
  const start = from.getTime();
  if (cutoff <= start) return 0;

  let total = 0;
  let currentStatus: string | null = null;
  let segmentStart = start;

  for (const row of rows) {
    const at = new Date(row.effective_at).getTime();
    if (at <= start) {
      currentStatus = row.status;
      continue;
    }
    if (at >= cutoff) break;
    if (currentStatus != null && currentStatus !== 'offline') {
      total += at - segmentStart;
    }
    currentStatus = row.status;
    segmentStart = at;
  }
  if (currentStatus != null && currentStatus !== 'offline') {
    total += cutoff - Math.max(segmentStart, start);
  }
  return Math.round(total / 1000);
}
