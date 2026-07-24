import { describe, expect, it } from 'vitest';
import {
  DROPOFF_RADIUS_M,
  PICKUP_RADIUS_M,
  decodePolyline,
  isFreshFix,
  proximityGate,
  proximityHint,
  shouldRefreshRoute,
} from '../route-eta';

const NOW = 1_700_000_000_000;
const PICKUP = { latitude: 47.6576822, longitude: -122.3196133 };
const NEARBY = { latitude: 47.6579, longitude: -122.3199 }; // ~40m
const FAR = { latitude: 47.6721, longitude: -122.3199 }; // ~1.6km

describe('isFreshFix', () => {
  it('accepts a recent fix and rejects stale/missing ones', () => {
    expect(isFreshFix({ fixAtMs: NOW - 5_000, now: NOW })).toBe(true);
    expect(isFreshFix({ fixAtMs: NOW - 61_000, now: NOW })).toBe(false);
    expect(isFreshFix({ fixAtMs: null, now: NOW })).toBe(false);
  });
});

describe('proximityGate — arrival', () => {
  it('allows arrival within the pickup radius on a fresh fix', () => {
    const gate = proximityGate({
      fix: { ...NEARBY, timestampMs: NOW - 3_000, accuracyM: 12 },
      target: PICKUP,
      radiusM: PICKUP_RADIUS_M,
      now: NOW,
    });
    expect(gate.allowed).toBe(true);
  });

  it('blocks arrival outside the radius with the distance in the hint', () => {
    const gate = proximityGate({
      fix: { ...FAR, timestampMs: NOW - 3_000 },
      target: PICKUP,
      radiusM: PICKUP_RADIUS_M,
      now: NOW,
    });
    expect(gate.allowed).toBe(false);
    expect(proximityHint(gate, 'pickup')).toMatch(/m from the pickup/);
  });

  it('blocks on stale fix and on poor accuracy even at the exact point', () => {
    expect(
      proximityGate({
        fix: { ...PICKUP, timestampMs: NOW - 120_000 },
        target: PICKUP,
        radiusM: PICKUP_RADIUS_M,
        now: NOW,
      }).allowed,
    ).toBe(false);
    expect(
      proximityGate({
        fix: { ...PICKUP, timestampMs: NOW - 1_000, accuracyM: 120 },
        target: PICKUP,
        radiusM: PICKUP_RADIUS_M,
        now: NOW,
      }).allowed,
    ).toBe(false);
  });
});

describe('proximityGate — completion', () => {
  it('allows completion near the destination, blocks it far away', () => {
    expect(
      proximityGate({
        fix: { ...NEARBY, timestampMs: NOW - 2_000 },
        target: PICKUP,
        radiusM: DROPOFF_RADIUS_M,
        now: NOW,
      }).allowed,
    ).toBe(true);
    expect(
      proximityGate({
        fix: { ...FAR, timestampMs: NOW - 2_000 },
        target: PICKUP,
        radiusM: DROPOFF_RADIUS_M,
        now: NOW,
      }).allowed,
    ).toBe(false);
  });
});

describe('shouldRefreshRoute', () => {
  it('fetches immediately when nothing is cached', () => {
    expect(
      shouldRefreshRoute({ lastFetchedAtMs: null, lastFetchedFrom: null, current: NEARBY, now: NOW }),
    ).toBe(true);
  });

  it('respects the time window and the movement threshold', () => {
    expect(
      shouldRefreshRoute({
        lastFetchedAtMs: NOW - 10_000,
        lastFetchedFrom: NEARBY,
        current: NEARBY,
        now: NOW,
      }),
    ).toBe(false);
    expect(
      shouldRefreshRoute({
        lastFetchedAtMs: NOW - 31_000,
        lastFetchedFrom: NEARBY,
        current: NEARBY,
        now: NOW,
      }),
    ).toBe(true);
    expect(
      shouldRefreshRoute({
        lastFetchedAtMs: NOW - 5_000,
        lastFetchedFrom: NEARBY,
        current: FAR,
        now: NOW,
      }),
    ).toBe(true);
  });
});

describe('decodePolyline', () => {
  it("decodes Google's documented example", () => {
    const points = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(points).toHaveLength(3);
    expect(points[0].latitude).toBeCloseTo(38.5, 3);
    expect(points[0].longitude).toBeCloseTo(-120.2, 3);
    expect(points[2].latitude).toBeCloseTo(43.252, 3);
    expect(points[2].longitude).toBeCloseTo(-126.453, 3);
  });
});
