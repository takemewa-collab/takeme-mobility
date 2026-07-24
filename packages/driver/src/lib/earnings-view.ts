/**
 * Pure presentation helpers for the Earnings dashboard. All inputs are the
 * server's local-date strings (YYYY-MM-DD, already computed in the driver's
 * timezone) — these helpers only label and scale, never re-aggregate.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Parse a YYYY-MM-DD local-date string without timezone reinterpretation. */
function parts(ymd: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!match) return null;
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

/** "Jul 20" from "2026-07-20". Falls back to the raw string when malformed. */
export function monthDayLabel(ymd: string): string {
  const p = parts(ymd);
  if (!p || p.m < 1 || p.m > 12) return ymd;
  return `${MONTHS[p.m - 1]} ${p.d}`;
}

/** "Jul 20 – Jul 26" for the week header. */
export function weekRangeLabel(startYmd: string, endYmd: string): string {
  return `${monthDayLabel(startYmd)} – ${monthDayLabel(endYmd)}`;
}

/** "Mon" for a local-date string (UTC math on components — no TZ drift). */
export function shortWeekday(ymd: string): string {
  const p = parts(ymd);
  if (!p) return '';
  const day = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
  return WEEKDAYS[day];
}

/** "Mon, Jul 20" — used for the selected-day panel. */
export function weekdayMonthDayLabel(ymd: string): string {
  const wd = shortWeekday(ymd);
  return wd ? `${wd}, ${monthDayLabel(ymd)}` : monthDayLabel(ymd);
}

/**
 * Scale the 7 daily gross values to 0..1 bar fractions against the week's
 * max. An all-zero week returns all zeros (the chart renders its axis and
 * baseline, with no bars — the honest empty state).
 */
export function barFractions(grossByDay: number[]): number[] {
  const max = Math.max(0, ...grossByDay);
  if (max <= 0) return grossByDay.map(() => 0);
  return grossByDay.map((g) => (g > 0 ? Math.max(0.04, g / max) : 0));
}

/**
 * Online time label from seconds. Sub-minute online time rounds to "1m" so a
 * driver who just went online never reads "0m" (which looks like fabricated
 * zero-data). Null input is the caller's cue to omit the stat entirely.
 */
export function formatOnlineDuration(totalSeconds: number): string {
  const minutes = Math.max(1, Math.round(totalSeconds / 60));
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/** Local YYYY-MM-DD of an ISO timestamp on THIS device (trip/day matching). */
export function localYmdOfIso(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Which earnings breakdown rows to show. Zero rows are hidden EXCEPT ride
 * earnings and net, which always render — a week with only tips must still
 * show "Ride earnings $0.00" rather than implying the field doesn't exist.
 */
export interface BreakdownRow {
  key: 'rideEarnings' | 'tips' | 'bonuses' | 'adjustments' | 'fees' | 'net';
  label: string;
  amountUsd: number;
  emphasized: boolean;
}

export function breakdownRows(summary: {
  rideEarningsUsd: number;
  tipsUsd: number;
  bonusesUsd: number;
  adjustmentsUsd: number;
  feesUsd: number;
  netUsd: number;
}): BreakdownRow[] {
  const rows: BreakdownRow[] = [
    { key: 'rideEarnings', label: 'Ride earnings', amountUsd: summary.rideEarningsUsd, emphasized: false },
  ];
  if (summary.tipsUsd !== 0) rows.push({ key: 'tips', label: 'Tips', amountUsd: summary.tipsUsd, emphasized: false });
  if (summary.bonusesUsd !== 0)
    rows.push({ key: 'bonuses', label: 'Bonuses', amountUsd: summary.bonusesUsd, emphasized: false });
  if (summary.adjustmentsUsd !== 0)
    rows.push({ key: 'adjustments', label: 'Adjustments', amountUsd: summary.adjustmentsUsd, emphasized: false });
  if (summary.feesUsd !== 0) rows.push({ key: 'fees', label: 'Fees', amountUsd: summary.feesUsd, emphasized: false });
  rows.push({ key: 'net', label: 'Net earnings', amountUsd: summary.netUsd, emphasized: true });
  return rows;
}
