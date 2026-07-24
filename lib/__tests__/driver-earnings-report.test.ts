import { describe, expect, it } from 'vitest';
import {
  addDays,
  bucketByLocalDay,
  isPayoutReturn,
  localDate,
  onlineSeconds,
  startOfLocalDay,
  summarizeEarnings,
  weekBounds,
} from '../driver-earnings-report';

const TZ = 'America/Los_Angeles';

describe('local calendar math', () => {
  it('buckets instants into the driver timezone, not UTC', () => {
    // 2026-07-25 02:30 UTC is 2026-07-24 19:30 in Seattle.
    expect(localDate('2026-07-25T02:30:00Z', TZ)).toBe('2026-07-24');
    expect(localDate('2026-07-25T02:30:00Z', 'UTC')).toBe('2026-07-25');
  });

  it('startOfLocalDay lands exactly on the local midnight boundary', () => {
    const start = startOfLocalDay('2026-07-24', TZ);
    expect(localDate(start, TZ)).toBe('2026-07-24');
    expect(localDate(new Date(start.getTime() - 60_000), TZ)).toBe('2026-07-23');
    // PDT is UTC-7: local midnight = 07:00 UTC.
    expect(start.toISOString()).toBe('2026-07-24T07:00:00.000Z');
  });

  it('weekBounds is Monday-start and 7 days long', () => {
    // 2026-07-24 is a Friday.
    const w = weekBounds('2026-07-24');
    expect(w.start).toBe('2026-07-20');
    expect(w.end).toBe('2026-07-26');
    expect(w.days).toHaveLength(7);
    expect(addDays(w.start, 7)).toBe('2026-07-27');
  });
});

describe('summarizeEarnings', () => {
  it('sums earnings by type; transfers (payout/card) are excluded', () => {
    const s = summarizeEarnings([
      { type: 'ride_earning', amount: '7.69', ride_id: 'r1', created_at: 'x' },
      { type: 'ride_earning', amount: 12.31, ride_id: 'r2', created_at: 'x' },
      { type: 'tip', amount: 3, created_at: 'x' },
      { type: 'bonus', amount: 5, created_at: 'x' },
      { type: 'fee', amount: -1.5, created_at: 'x' },
      { type: 'adjustment', amount: -2, created_at: 'x' },
      { type: 'payout', amount: -20, created_at: 'x' },
      { type: 'card_fund', amount: 20, created_at: 'x' },
    ]);
    expect(s.rideEarningsUsd).toBe(20);
    expect(s.tipsUsd).toBe(3);
    expect(s.bonusesUsd).toBe(5);
    expect(s.grossUsd).toBe(28);
    expect(s.feesUsd).toBe(-1.5);
    expect(s.adjustmentsUsd).toBe(-2);
    expect(s.netUsd).toBe(24.5);
    expect(s.trips).toBe(2);
  });

  it('zero rows → all-zero summary (a real empty state, not fabricated)', () => {
    const s = summarizeEarnings([]);
    expect(s.grossUsd).toBe(0);
    expect(s.netUsd).toBe(0);
    expect(s.trips).toBe(0);
  });

  it('duplicate ride ids count one trip', () => {
    const s = summarizeEarnings([
      { type: 'ride_earning', amount: 5, ride_id: 'r1', created_at: 'x' },
      { type: 'ride_earning', amount: 5, ride_id: 'r1', created_at: 'x' },
    ]);
    expect(s.trips).toBe(1);
  });
});

describe('isPayoutReturn', () => {
  it('flags payout-failure returns so they are not shown as earnings', () => {
    expect(
      isPayoutReturn({
        type: 'adjustment',
        amount: 20,
        created_at: 'x',
        description: 'Payout failed — funds returned',
      }),
    ).toBe(true);
    expect(
      isPayoutReturn({ type: 'adjustment', amount: 4, created_at: 'x', description: 'Fare adjustment' }),
    ).toBe(false);
  });
});

describe('bucketByLocalDay', () => {
  it('assigns late-evening Seattle earnings to the local day', () => {
    const w = weekBounds('2026-07-24');
    const buckets = bucketByLocalDay(
      [
        // 2026-07-25T02:30Z = Fri Jul 24 19:30 PDT
        { type: 'ride_earning', amount: 10, ride_id: 'r1', created_at: '2026-07-25T02:30:00Z' },
        // Mon morning
        { type: 'ride_earning', amount: 4, ride_id: 'r2', created_at: '2026-07-20T15:00:00Z' },
      ],
      w.days,
      TZ,
    );
    const friday = buckets.find((b) => b.date === '2026-07-24');
    const monday = buckets.find((b) => b.date === '2026-07-20');
    expect(friday?.earnings.grossUsd).toBe(10);
    expect(monday?.earnings.grossUsd).toBe(4);
    expect(buckets.filter((b) => b.earnings.grossUsd === 0)).toHaveLength(5);
  });
});

describe('onlineSeconds', () => {
  const from = new Date('2026-07-24T00:00:00Z');
  const to = new Date('2026-07-25T00:00:00Z');
  const now = new Date('2026-07-26T00:00:00Z');

  it('null when tracking has no history at all — never a fake zero', () => {
    expect(onlineSeconds([], from, to, now)).toBeNull();
  });

  it('sums online intervals, treating busy/on_trip as online', () => {
    const rows = [
      { status: 'available', effective_at: '2026-07-24T01:00:00Z' },
      { status: 'on_trip', effective_at: '2026-07-24T02:00:00Z' },
      { status: 'available', effective_at: '2026-07-24T03:00:00Z' },
      { status: 'offline', effective_at: '2026-07-24T04:00:00Z' },
    ];
    expect(onlineSeconds(rows, from, to, now)).toBe(3 * 3600);
  });

  it('uses the pre-window transition as the opening state and clips to the window', () => {
    const rows = [
      { status: 'available', effective_at: '2026-07-23T22:00:00Z' }, // before window
      { status: 'offline', effective_at: '2026-07-24T01:30:00Z' },
    ];
    expect(onlineSeconds(rows, from, to, now)).toBe(1.5 * 3600);
  });

  it('an open online segment runs to now, not to the window end', () => {
    const rows = [{ status: 'available', effective_at: '2026-07-24T20:00:00Z' }];
    // now beyond window end → clipped at `to` (4h)
    expect(onlineSeconds(rows, from, to, now)).toBe(4 * 3600);
    // now inside the window → clipped at now (2h)
    expect(onlineSeconds(rows, from, to, new Date('2026-07-24T22:00:00Z'))).toBe(2 * 3600);
  });
});
