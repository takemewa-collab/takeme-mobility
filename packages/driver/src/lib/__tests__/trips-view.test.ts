import { describe, expect, it } from 'vitest';
import { dayTitle, groupTripsByDay, mergeTripPages, tripRouteForStatus } from '../trips-view';

// Build a local-time ISO for a given local day/hour on this machine, so the
// grouping (which is device-local by design) is deterministic in any TZ.
const at = (y: number, m: number, d: number, h: number) => new Date(y, m - 1, d, h).toISOString();

describe('groupTripsByDay', () => {
  const trips = [
    { id: 'a', requestedAt: at(2026, 7, 24, 18) },
    { id: 'b', requestedAt: at(2026, 7, 24, 9) },
    { id: 'c', requestedAt: at(2026, 7, 23, 22) },
    { id: 'd', requestedAt: at(2026, 7, 20, 8) },
  ];

  it('sections a newest-first list by local day', () => {
    const sections = groupTripsByDay(trips, '2026-07-24', '2026-07-23');
    expect(sections.map((s) => s.trips.map((t) => t.id))).toEqual([['a', 'b'], ['c'], ['d']]);
    expect(sections[0].title).toBe('Today');
    expect(sections[1].title).toBe('Yesterday');
    expect(sections[2].title).toBe('Mon, Jul 20');
  });

  it('drops trips with unparseable timestamps instead of mislabeling', () => {
    const sections = groupTripsByDay(
      [{ id: 'x', requestedAt: 'garbage' }],
      '2026-07-24',
      '2026-07-23',
    );
    expect(sections).toEqual([]);
  });
});

describe('dayTitle', () => {
  it('uses relative names only for today and yesterday', () => {
    expect(dayTitle('2026-07-24', '2026-07-24', '2026-07-23')).toBe('Today');
    expect(dayTitle('2026-07-23', '2026-07-24', '2026-07-23')).toBe('Yesterday');
    expect(dayTitle('2026-07-19', '2026-07-24', '2026-07-23')).toBe('Sun, Jul 19');
  });
});

describe('mergeTripPages', () => {
  it('appends new pages and dedupes overlap by id', () => {
    const page1 = [
      { id: 'a', requestedAt: at(2026, 7, 24, 18) },
      { id: 'b', requestedAt: at(2026, 7, 24, 9) },
    ];
    const page2 = [
      { id: 'b', requestedAt: at(2026, 7, 24, 9) },
      { id: 'c', requestedAt: at(2026, 7, 23, 22) },
    ];
    expect(mergeTripPages(page1, page2).map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('tripRouteForStatus — resume routes mirror the trip flow', () => {
  it('maps each in-flight status to its screen', () => {
    expect(tripRouteForStatus('driver_assigned')).toBe('/(app)/trip/incoming');
    expect(tripRouteForStatus('driver_arriving')).toBe('/(app)/trip/navigate');
    expect(tripRouteForStatus('arrived')).toBe('/(app)/trip/arrived');
    expect(tripRouteForStatus('in_progress')).toBe('/(app)/trip/active');
  });

  it('terminal or unknown statuses have no resume route', () => {
    expect(tripRouteForStatus('completed')).toBeNull();
    expect(tripRouteForStatus('cancelled')).toBeNull();
    expect(tripRouteForStatus('searching_driver')).toBeNull();
  });
});
