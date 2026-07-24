import { describe, expect, it } from 'vitest';
import { heartbeatPayload, shouldSendHeartbeat } from '../location-heartbeat';

describe('shouldSendHeartbeat', () => {
  it('never sends while offline (server 400s those)', () => {
    expect(
      shouldSendHeartbeat({ status: 'offline', lastSentAt: null, now: 1000, throttleMs: 3000 }),
    ).toBe(false);
  });

  it('sends immediately for the first fix while online', () => {
    for (const status of ['available', 'busy', 'on_trip'] as const) {
      expect(
        shouldSendHeartbeat({ status, lastSentAt: null, now: 1000, throttleMs: 3000 }),
      ).toBe(true);
    }
  });

  it('throttles within the window and resumes after it', () => {
    expect(
      shouldSendHeartbeat({ status: 'available', lastSentAt: 1000, now: 3999, throttleMs: 3000 }),
    ).toBe(false);
    expect(
      shouldSendHeartbeat({ status: 'available', lastSentAt: 1000, now: 4000, throttleMs: 3000 }),
    ).toBe(true);
  });
});

describe('heartbeatPayload', () => {
  it('always carries lat/lng', () => {
    expect(heartbeatPayload({ latitude: 47.6, longitude: -122.3 })).toEqual({
      lat: 47.6,
      lng: -122.3,
    });
  });

  it('drops the iOS unknown-heading sentinel (-1) and out-of-range values', () => {
    expect(heartbeatPayload({ latitude: 1, longitude: 2, heading: -1 }).heading).toBeUndefined();
    expect(heartbeatPayload({ latitude: 1, longitude: 2, heading: 361 }).heading).toBeUndefined();
    expect(heartbeatPayload({ latitude: 1, longitude: 2, heading: 90 }).heading).toBe(90);
    expect(heartbeatPayload({ latitude: 1, longitude: 2, heading: 0 }).heading).toBe(0);
  });

  it('converts speed m/s → km/h and drops negatives', () => {
    expect(heartbeatPayload({ latitude: 1, longitude: 2, speed: 10 }).speedKmh).toBe(36);
    expect(heartbeatPayload({ latitude: 1, longitude: 2, speed: -1 }).speedKmh).toBeUndefined();
    expect(heartbeatPayload({ latitude: 1, longitude: 2, speed: null }).speedKmh).toBeUndefined();
  });
});
