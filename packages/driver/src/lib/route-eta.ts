/**
 * Live-trip routing math for the driver app — pure and unit-tested.
 *
 * ROOT CAUSE this replaces: the navigate screen showed `ride.duration_min`
 * ("12 min to pickup") — the PICKUP→DESTINATION trip duration from the
 * quote — as the driver's ETA to the pickup. The real ETA comes from a
 * driving route between the driver's current fix and the target
 * (GET /api/driver/route); these helpers keep the client honest about
 * freshness and provide the proximity gating the UI mirrors.
 */

export const PICKUP_RADIUS_M = 100;
export const DROPOFF_RADIUS_M = 150;
export const MAX_FIX_AGE_MS = 60_000;
export const MAX_ACCURACY_M = 75;
/** Refresh the driving route at most this often… */
export const ROUTE_REFRESH_MS = 30_000;
/** …or sooner when the driver has moved at least this far. */
export const ROUTE_REFRESH_MOVE_M = 150;

export function haversineMeters(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const R = 6_371_000;
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLng = ((b.longitude - a.longitude) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.latitude * Math.PI) / 180) *
      Math.cos((b.latitude * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** A fix older than MAX_FIX_AGE_MS proves nothing — never compute from it. */
export function isFreshFix(input: { fixAtMs: number | null; now: number; maxAgeMs?: number }): boolean {
  if (input.fixAtMs == null) return false;
  return input.now - input.fixAtMs <= (input.maxAgeMs ?? MAX_FIX_AGE_MS);
}

export type ProximityGate =
  | { allowed: true; distanceM: number }
  | { allowed: false; reason: 'no_location' | 'stale_location' | 'inaccurate_location' | 'too_far'; distanceM: number | null };

/** Client mirror of the server's arrived/complete geofence gate. */
export function proximityGate(input: {
  fix: { latitude: number; longitude: number; timestampMs: number; accuracyM?: number | null } | null;
  target: { latitude: number; longitude: number };
  radiusM: number;
  now: number;
}): ProximityGate {
  if (!input.fix) return { allowed: false, reason: 'no_location', distanceM: null };
  if (!isFreshFix({ fixAtMs: input.fix.timestampMs, now: input.now })) {
    return { allowed: false, reason: 'stale_location', distanceM: null };
  }
  if (input.fix.accuracyM != null && input.fix.accuracyM > MAX_ACCURACY_M) {
    return { allowed: false, reason: 'inaccurate_location', distanceM: null };
  }
  const distanceM = Math.round(haversineMeters(input.fix, input.target));
  if (distanceM > input.radiusM) return { allowed: false, reason: 'too_far', distanceM };
  return { allowed: true, distanceM };
}

export function proximityHint(gate: ProximityGate, what: 'pickup' | 'destination'): string | null {
  if (gate.allowed) return null;
  switch (gate.reason) {
    case 'no_location':
      return 'Waiting for your location…';
    case 'stale_location':
      return 'Waiting for a fresh GPS fix…';
    case 'inaccurate_location':
      return 'GPS accuracy is low — move to open sky.';
    case 'too_far':
      return `${gate.distanceM}m from the ${what} — get closer to continue.`;
  }
}

/** Should the route be refetched, given the last fetch and movement since? */
export function shouldRefreshRoute(input: {
  lastFetchedAtMs: number | null;
  lastFetchedFrom: { latitude: number; longitude: number } | null;
  current: { latitude: number; longitude: number };
  now: number;
}): boolean {
  if (input.lastFetchedAtMs == null || !input.lastFetchedFrom) return true;
  if (input.now - input.lastFetchedAtMs >= ROUTE_REFRESH_MS) return true;
  return haversineMeters(input.lastFetchedFrom, input.current) >= ROUTE_REFRESH_MOVE_M;
}

/** Google encoded-polyline → coordinates for react-native-maps Polyline. */
export function decodePolyline(encoded: string): { latitude: number; longitude: number }[] {
  const points: { latitude: number; longitude: number }[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    for (const which of [0, 1] as const) {
      let result = 0;
      let shift = 0;
      let byte = 0x20;
      while (byte >= 0x20) {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      }
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += delta;
      else lng += delta;
    }
    points.push({ latitude: lat / 1e5, longitude: lng / 1e5 });
  }
  return points;
}
