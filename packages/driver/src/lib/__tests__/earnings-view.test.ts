import { describe, expect, it } from 'vitest';
import {
  barFractions,
  breakdownRows,
  formatOnlineDuration,
  localYmdOfIso,
  monthDayLabel,
  shortWeekday,
  weekRangeLabel,
} from '../earnings-view';

describe('week and day labels', () => {
  it('formats the week range like the spec', () => {
    expect(weekRangeLabel('2026-07-20', '2026-07-26')).toBe('Jul 20 – Jul 26');
  });

  it('labels weekdays without timezone drift (server local dates stay put)', () => {
    // 2026-07-20 is a Monday regardless of the device timezone.
    expect(shortWeekday('2026-07-20')).toBe('Mon');
    expect(shortWeekday('2026-07-26')).toBe('Sun');
  });

  it('falls back to the raw string for malformed dates', () => {
    expect(monthDayLabel('not-a-date')).toBe('not-a-date');
  });
});

describe('barFractions — 7-bar chart scaling', () => {
  it('scales to the max day', () => {
    const f = barFractions([0, 50, 100, 25, 0, 0, 0]);
    expect(f[2]).toBe(1);
    expect(f[1]).toBe(0.5);
    expect(f[0]).toBe(0);
  });

  it('an all-zero week renders no bars (empty state keeps the axis)', () => {
    expect(barFractions([0, 0, 0, 0, 0, 0, 0])).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it('tiny nonzero days stay visible (minimum fraction)', () => {
    const f = barFractions([0.5, 200, 0, 0, 0, 0, 0]);
    expect(f[0]).toBeGreaterThanOrEqual(0.04);
  });
});

describe('formatOnlineDuration', () => {
  it('formats hours and minutes', () => {
    expect(formatOnlineDuration(6 * 3600 + 12 * 60)).toBe('6h 12m');
    expect(formatOnlineDuration(3600)).toBe('1h');
    expect(formatOnlineDuration(42 * 60)).toBe('42m');
  });

  it('never shows a fabricated-looking zero', () => {
    expect(formatOnlineDuration(20)).toBe('1m');
  });
});

describe('localYmdOfIso', () => {
  it('returns a device-local YYYY-MM-DD', () => {
    expect(localYmdOfIso(new Date(2026, 6, 24, 13, 30).toISOString())).toBe('2026-07-24');
  });

  it('rejects unparseable timestamps', () => {
    expect(localYmdOfIso('garbage')).toBeNull();
  });
});

describe('breakdownRows — hide zero rows except ride earnings and net', () => {
  const base = {
    rideEarningsUsd: 0,
    tipsUsd: 0,
    bonusesUsd: 0,
    adjustmentsUsd: 0,
    feesUsd: 0,
    netUsd: 0,
  };

  it('an empty week still shows ride earnings and net', () => {
    expect(breakdownRows(base).map((r) => r.key)).toEqual(['rideEarnings', 'net']);
  });

  it('nonzero optional rows appear in order', () => {
    const rows = breakdownRows({
      ...base,
      rideEarningsUsd: 80,
      tipsUsd: 12,
      feesUsd: -3,
      netUsd: 89,
    });
    expect(rows.map((r) => r.key)).toEqual(['rideEarnings', 'tips', 'fees', 'net']);
  });

  it('negative adjustments still render (nonzero)', () => {
    const rows = breakdownRows({ ...base, adjustmentsUsd: -4.5 });
    expect(rows.some((r) => r.key === 'adjustments')).toBe(true);
  });

  it('net is the emphasized final row', () => {
    const rows = breakdownRows({ ...base, rideEarningsUsd: 10, netUsd: 10 });
    expect(rows[rows.length - 1]).toMatchObject({ key: 'net', emphasized: true });
  });
});
