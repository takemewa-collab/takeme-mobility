import { describe, expect, it } from 'vitest';
import { monitorEmailReason } from '../monitoring/email-policy';

const NOW = new Date('2026-07-24T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

const base = {
  currentFailed: 0,
  previousRunHealthy: true as boolean | null,
  digestEveryHours: null as number | null,
  lastDigestAt: null as Date | null,
  now: NOW,
};

describe('monitorEmailReason', () => {
  it('routine success sends nothing', () => {
    expect(monitorEmailReason({ ...base })).toBeNull();
  });

  it('any failing step sends a failure email', () => {
    expect(monitorEmailReason({ ...base, currentFailed: 1 })).toBe('failure');
    expect(monitorEmailReason({ ...base, currentFailed: 3, previousRunHealthy: false })).toBe('failure');
  });

  it('failing → healthy transition sends a recovery email exactly when prev run failed', () => {
    expect(monitorEmailReason({ ...base, previousRunHealthy: false })).toBe('recovery');
    expect(monitorEmailReason({ ...base, previousRunHealthy: true })).toBeNull();
  });

  it('no history means no recovery email', () => {
    expect(monitorEmailReason({ ...base, previousRunHealthy: null })).toBeNull();
  });

  it('digest fires when configured and due', () => {
    expect(
      monitorEmailReason({ ...base, digestEveryHours: 24, lastDigestAt: hoursAgo(25) }),
    ).toBe('digest');
    expect(
      monitorEmailReason({ ...base, digestEveryHours: 24, lastDigestAt: null }),
    ).toBe('digest');
  });

  it('digest stays quiet when not due or not configured', () => {
    expect(
      monitorEmailReason({ ...base, digestEveryHours: 24, lastDigestAt: hoursAgo(2) }),
    ).toBeNull();
    expect(monitorEmailReason({ ...base, digestEveryHours: null, lastDigestAt: hoursAgo(100) })).toBeNull();
    expect(monitorEmailReason({ ...base, digestEveryHours: 0, lastDigestAt: null })).toBeNull();
  });

  it('failure outranks digest and recovery', () => {
    expect(
      monitorEmailReason({
        ...base,
        currentFailed: 1,
        previousRunHealthy: false,
        digestEveryHours: 24,
        lastDigestAt: hoursAgo(48),
      }),
    ).toBe('failure');
  });
});
