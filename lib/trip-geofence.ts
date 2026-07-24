// ═══════════════════════════════════════════════════════════════════════════
// Server-authoritative trip geofencing — pure and unit-tested.
//
// "Arrived at pickup" and "Complete trip" are money-adjacent transitions:
// completion captures the fare and credits driver earnings. Neither may rely
// on client honesty, so the driver/rides API validates the driver's LATEST
// server-known location (driver_locations) against the target before
// allowing the transition. Stale or inaccurate fixes are rejected outright —
// a missing/old coordinate must never pass as "close enough".
// ═══════════════════════════════════════════════════════════════════════════

/** Drivers must be within this of the pickup to mark "arrived". */
export const PICKUP_RADIUS_M = 100;
/** Drivers must be within this of the destination to complete the trip. */
export const DROPOFF_RADIUS_M = 150;
/** A location fix older than this cannot prove anything. */
export const MAX_FIX_AGE_MS = 60_000;
/** Fixes with worse reported accuracy than this are unusable for gating. */
export const MAX_ACCURACY_M = 75;

export function haversineMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6_371_000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/**
 * PostGIS point → {lat,lng}. PostgREST serializes geography as EWKB hex
 * (e.g. 0101000020E61000…); realtime/readers may also hand over GeoJSON
 * objects or WKT strings. All three are handled; anything else is null.
 */
export function parseGeoPoint(value: unknown): { lat: number; lng: number } | null {
  if (value && typeof value === 'object') {
    const geo = value as { coordinates?: number[] };
    if (Array.isArray(geo.coordinates) && geo.coordinates.length >= 2) {
      return { lng: geo.coordinates[0], lat: geo.coordinates[1] };
    }
    return null;
  }
  if (typeof value !== 'string') return null;

  const wkt = /POINT\(([-0-9.]+) ([-0-9.]+)\)/.exec(value);
  if (wkt) return { lng: Number(wkt[1]), lat: Number(wkt[2]) };

  // (E)WKB hex: [1B byte order][4B type (+SRID flag 0x20000000)][4B srid?][8B x][8B y]
  if (/^[0-9A-Fa-f]{34,}$/.test(value)) {
    try {
      const bytes = Buffer.from(value, 'hex');
      const littleEndian = bytes[0] === 1;
      const type = littleEndian ? bytes.readUInt32LE(1) : bytes.readUInt32BE(1);
      if ((type & 0xff) !== 1) return null; // not a point
      const hasSrid = (type & 0x20000000) !== 0;
      const offset = 5 + (hasSrid ? 4 : 0);
      if (bytes.length < offset + 16) return null;
      const x = littleEndian ? bytes.readDoubleLE(offset) : bytes.readDoubleBE(offset);
      const y = littleEndian ? bytes.readDoubleLE(offset + 8) : bytes.readDoubleBE(offset + 8);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return { lng: x, lat: y };
    } catch {
      return null;
    }
  }
  return null;
}

export type ProximityReason =
  | 'ok'
  | 'no_location'
  | 'stale_location'
  | 'inaccurate_location'
  | 'too_far';

export interface ProximityCheck {
  ok: boolean;
  reason: ProximityReason;
  distanceM: number | null;
}

export function assessProximity(input: {
  fix: { lat: number; lng: number; updatedAt: string | Date; accuracyM?: number | null } | null;
  target: { lat: number; lng: number };
  radiusM: number;
  now?: Date;
  maxAgeMs?: number;
  maxAccuracyM?: number;
}): ProximityCheck {
  const { fix, target, radiusM } = input;
  if (!fix) return { ok: false, reason: 'no_location', distanceM: null };

  const now = input.now ?? new Date();
  const updatedAt = new Date(fix.updatedAt);
  const maxAge = input.maxAgeMs ?? MAX_FIX_AGE_MS;
  if (!Number.isFinite(updatedAt.getTime()) || now.getTime() - updatedAt.getTime() > maxAge) {
    return { ok: false, reason: 'stale_location', distanceM: null };
  }

  const maxAccuracy = input.maxAccuracyM ?? MAX_ACCURACY_M;
  if (fix.accuracyM != null && fix.accuracyM > maxAccuracy) {
    return { ok: false, reason: 'inaccurate_location', distanceM: null };
  }

  const distanceM = Math.round(haversineMeters(fix, target));
  if (distanceM > radiusM) return { ok: false, reason: 'too_far', distanceM };
  return { ok: true, reason: 'ok', distanceM };
}

/** Driver-facing message for a failed check. */
export function proximityErrorMessage(check: ProximityCheck, what: 'pickup' | 'destination'): string {
  switch (check.reason) {
    case 'no_location':
      return 'We have no recent location for you. Check location permissions and try again.';
    case 'stale_location':
      return 'Your location is out of date. Wait for a GPS fix and try again.';
    case 'inaccurate_location':
      return 'GPS accuracy is too low right now. Move to open sky and try again.';
    case 'too_far':
      return `You're ${check.distanceM ?? '?'}m from the ${what}. Get closer and try again.`;
    default:
      return 'Location check failed.';
  }
}
