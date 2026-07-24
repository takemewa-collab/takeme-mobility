import { describe, expect, it } from 'vitest';
import {
  DROPOFF_RADIUS_M,
  MAX_ACCURACY_M,
  MAX_FIX_AGE_MS,
  PICKUP_RADIUS_M,
  assessProximity,
  haversineMeters,
  parseGeoPoint,
  proximityErrorMessage,
} from '../trip-geofence';

const NOW = new Date('2026-07-24T12:00:00Z');
const FRESH = new Date(NOW.getTime() - 5_000).toISOString();
const STALE = new Date(NOW.getTime() - MAX_FIX_AGE_MS - 1_000).toISOString();

// ~40m apart (real pair from the Seattle test trip).
const PICKUP = { lat: 47.6576822, lng: -122.3196133 };
const NEARBY = { lat: 47.6579, lng: -122.3199 };
// ~1.6km away.
const FAR = { lat: 47.6721, lng: -122.3199 };

describe('haversineMeters', () => {
  it('measures the nearby pair at roughly 40m and the far pair at ~1.6km', () => {
    const near = haversineMeters(NEARBY, PICKUP);
    expect(near).toBeGreaterThan(20);
    expect(near).toBeLessThan(60);
    expect(haversineMeters(FAR, PICKUP)).toBeGreaterThan(1_000);
  });
});

describe('assessProximity — pickup gating', () => {
  it('accepts a fresh, accurate fix inside the pickup radius', () => {
    const check = assessProximity({
      fix: { ...NEARBY, updatedAt: FRESH, accuracyM: 10 },
      target: PICKUP,
      radiusM: PICKUP_RADIUS_M,
      now: NOW,
    });
    expect(check).toMatchObject({ ok: true, reason: 'ok' });
    expect(check.distanceM).toBeLessThanOrEqual(PICKUP_RADIUS_M);
  });

  it('rejects arrival outside the pickup radius, reporting the distance', () => {
    const check = assessProximity({
      fix: { ...FAR, updatedAt: FRESH },
      target: PICKUP,
      radiusM: PICKUP_RADIUS_M,
      now: NOW,
    });
    expect(check.ok).toBe(false);
    expect(check.reason).toBe('too_far');
    expect(check.distanceM).toBeGreaterThan(PICKUP_RADIUS_M);
    expect(proximityErrorMessage(check, 'pickup')).toMatch(/closer/i);
  });

  it('rejects a stale fix even at the exact pickup point', () => {
    const check = assessProximity({
      fix: { ...PICKUP, updatedAt: STALE },
      target: PICKUP,
      radiusM: PICKUP_RADIUS_M,
      now: NOW,
    });
    expect(check).toMatchObject({ ok: false, reason: 'stale_location' });
  });

  it('rejects an inaccurate fix even at the exact pickup point', () => {
    const check = assessProximity({
      fix: { ...PICKUP, updatedAt: FRESH, accuracyM: MAX_ACCURACY_M + 1 },
      target: PICKUP,
      radiusM: PICKUP_RADIUS_M,
      now: NOW,
    });
    expect(check).toMatchObject({ ok: false, reason: 'inaccurate_location' });
  });

  it('rejects when no location exists at all', () => {
    const check = assessProximity({ fix: null, target: PICKUP, radiusM: PICKUP_RADIUS_M, now: NOW });
    expect(check).toMatchObject({ ok: false, reason: 'no_location', distanceM: null });
  });
});

describe('assessProximity — completion gating', () => {
  it('accepts completion near the destination', () => {
    const check = assessProximity({
      fix: { ...NEARBY, updatedAt: FRESH },
      target: PICKUP,
      radiusM: DROPOFF_RADIUS_M,
      now: NOW,
    });
    expect(check.ok).toBe(true);
  });

  it('rejects completion outside the destination radius', () => {
    const check = assessProximity({
      fix: { ...FAR, updatedAt: FRESH },
      target: PICKUP,
      radiusM: DROPOFF_RADIUS_M,
      now: NOW,
    });
    expect(check).toMatchObject({ ok: false, reason: 'too_far' });
  });
});

describe('parseGeoPoint', () => {
  it('decodes PostgREST EWKB hex (real production sample)', () => {
    const point = parseGeoPoint('0101000020E6100000B3EC496073955EC07C45B75ED3CD4740');
    expect(point).not.toBeNull();
    expect(point!.lat).toBeCloseTo(47.608013, 5);
    expect(point!.lng).toBeCloseTo(-122.335167, 5);
  });

  it('decodes GeoJSON objects and WKT strings', () => {
    expect(parseGeoPoint({ coordinates: [-122.3, 47.6] })).toEqual({ lng: -122.3, lat: 47.6 });
    expect(parseGeoPoint('POINT(-122.3 47.6)')).toEqual({ lng: -122.3, lat: 47.6 });
  });

  it('returns null for junk', () => {
    expect(parseGeoPoint(null)).toBeNull();
    expect(parseGeoPoint('not-a-point')).toBeNull();
    expect(parseGeoPoint('0102000020E610000000')).toBeNull(); // not a point type
  });
});
