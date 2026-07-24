/**
 * Pure helpers for the Trips tab: day sectioning, pagination merging, and
 * mapping an in-flight trip's status to the screen that resumes it.
 */

import { localYmdOfIso, weekdayMonthDayLabel } from './earnings-view';

export interface TripLike {
  id: string;
  requestedAt: string;
}

export interface DaySection<T extends TripLike> {
  /** Local YYYY-MM-DD on this device. */
  ymd: string;
  title: string;
  trips: T[];
}

/** "Today" / "Yesterday" / "Mon, Jul 20" given the device-local today. */
export function dayTitle(ymd: string, todayYmd: string, yesterdayYmd: string): string {
  if (ymd === todayYmd) return 'Today';
  if (ymd === yesterdayYmd) return 'Yesterday';
  return weekdayMonthDayLabel(ymd);
}

/**
 * Group an already-sorted (newest-first) trip list into day sections by the
 * trip's requested time in the device's local timezone. Trips whose
 * timestamp fails to parse are dropped rather than mislabeled.
 */
export function groupTripsByDay<T extends TripLike>(
  trips: T[],
  todayYmd: string,
  yesterdayYmd: string,
): DaySection<T>[] {
  const sections: DaySection<T>[] = [];
  for (const trip of trips) {
    const ymd = localYmdOfIso(trip.requestedAt);
    if (!ymd) continue;
    const last = sections[sections.length - 1];
    if (last && last.ymd === ymd) {
      last.trips.push(trip);
    } else {
      sections.push({ ymd, title: dayTitle(ymd, todayYmd, yesterdayYmd), trips: [trip] });
    }
  }
  return sections;
}

/**
 * Merge a pagination page into the accumulated list, deduping by id (a trip
 * can straddle pages when new trips complete between requests).
 */
export function mergeTripPages<T extends TripLike>(existing: T[], incoming: T[]): T[] {
  const seen = new Set(existing.map((t) => t.id));
  const merged = [...existing];
  for (const trip of incoming) {
    if (!seen.has(trip.id)) {
      seen.add(trip.id);
      merged.push(trip);
    }
  }
  return merged;
}

/**
 * The screen that resumes an active trip. Mirrors the existing trip flow:
 * assignment lands on /incoming, en-route drivers on /navigate, at-pickup on
 * /arrived, riding on /active. Unknown/terminal statuses return null (no
 * pinned row).
 */
export function tripRouteForStatus(status: string): string | null {
  switch (status) {
    case 'driver_assigned':
      return '/(app)/trip/incoming';
    case 'driver_arriving':
      return '/(app)/trip/navigate';
    case 'arrived':
      return '/(app)/trip/arrived';
    case 'in_progress':
      return '/(app)/trip/active';
    default:
      return null;
  }
}

/** Device-local "today"/"yesterday" anchors for day sectioning (DST-safe). */
export function dayAnchors(now: Date): { todayYmd: string; yesterdayYmd: string } {
  const pad = (n: number) => `${n}`.padStart(2, '0');
  const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  return { todayYmd: ymd(now), yesterdayYmd: ymd(yesterday) };
}

/** "3:42 PM" from an ISO timestamp, device-local. */
export function timeLabel(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
