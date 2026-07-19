import { describe, expect, it } from 'vitest';
import {
  MAX_INTERMEDIATE_STOPS,
  routePointsArraySchema,
  routeTotalsPlausible,
  validateRoutePoints,
  type RoutePointInput,
} from '../route-points';

// Downtown Seattle test fixtures — each point ~1km apart.
const P = (type: RoutePointInput['type'], seq: number, lat: number, lng: number): RoutePointInput => ({
  type,
  seq,
  formattedAddress: `${seq} Test St, Seattle, WA`,
  lat,
  lng,
});

const pickup = P('pickup', 0, 47.608, -122.335);
const stop1 = P('stop', 1, 47.615, -122.33);
const stop2 = P('stop', 2, 47.62, -122.325);
const stop3 = P('stop', 3, 47.625, -122.32);
const drop = (seq: number) => P('dropoff', seq, 47.63, -122.31);

describe('validateRoutePoints', () => {
  it('accepts a classic two-point route', () => {
    const r = validateRoutePoints([pickup, drop(1)]);
    expect(r.ok).toBe(true);
    expect(r.ordered?.map((p) => p.type)).toEqual(['pickup', 'dropoff']);
  });

  it('accepts one intermediate stop', () => {
    expect(validateRoutePoints([pickup, stop1, drop(2)]).ok).toBe(true);
  });

  it('accepts the maximum of three stops', () => {
    expect(validateRoutePoints([pickup, stop1, stop2, stop3, drop(4)]).ok).toBe(true);
  });

  it('rejects more than three stops (schema layer)', () => {
    const four = [pickup, stop1, stop2, stop3, P('stop', 4, 47.628, -122.315), drop(5)];
    expect(routePointsArraySchema.safeParse(four).success).toBe(false);
  });

  it('sorts by seq regardless of submission order', () => {
    const r = validateRoutePoints([drop(2), pickup, stop1]);
    expect(r.ok).toBe(true);
    expect(r.ordered?.map((p) => p.seq)).toEqual([0, 1, 2]);
  });

  it('rejects duplicate sequence numbers', () => {
    const r = validateRoutePoints([pickup, { ...stop1, seq: 1 }, { ...stop2, seq: 1 }, drop(2)]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Duplicate/i);
  });

  it('rejects non-contiguous sequences', () => {
    const r = validateRoutePoints([pickup, { ...stop1, seq: 2 }, drop(3)]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/contiguous/i);
  });

  it('rejects a route that does not start with pickup', () => {
    const r = validateRoutePoints([{ ...stop1, seq: 0 }, { ...pickup, seq: 1 }, drop(2)]);
    expect(r.ok).toBe(false);
  });

  it('rejects a route that does not end with the dropoff', () => {
    const r = validateRoutePoints([pickup, { ...drop(1), seq: 1 }, { ...stop2, seq: 2 }]);
    expect(r.ok).toBe(false);
  });

  it('rejects two pickups', () => {
    const r = validateRoutePoints([pickup, { ...pickup, seq: 1, type: 'pickup' }, drop(2)]);
    expect(r.ok).toBe(false);
  });

  it('rejects null-island coordinates', () => {
    const r = validateRoutePoints([pickup, { ...stop1, lat: 0, lng: 0 }, drop(2)]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/coordinates/i);
  });

  it('rejects consecutive points at the same place', () => {
    const r = validateRoutePoints([pickup, { ...stop1, lat: pickup.lat, lng: pickup.lng }, drop(2)]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/same place/i);
  });

  it('exposes the configured stop limit', () => {
    expect(MAX_INTERMEDIATE_STOPS).toBe(3);
  });
});

describe('routeTotalsPlausible', () => {
  const route = [pickup, stop1, drop(2)];
  // Straight-line through these points is ~2.6 km.
  it('accepts realistic driving totals', () => {
    expect(routeTotalsPlausible(route, 3.4)).toBe(true);
  });
  it('rejects a distance shorter than the straight line', () => {
    expect(routeTotalsPlausible(route, 0.4)).toBe(false);
  });
  it('rejects absurdly inflated totals', () => {
    expect(routeTotalsPlausible(route, 250)).toBe(false);
  });
});
