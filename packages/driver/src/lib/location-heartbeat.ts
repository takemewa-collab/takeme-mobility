/**
 * Foreground location heartbeat policy — pure and unit-tested.
 *
 * PRODUCTION INCIDENT ROOT CAUSE: the foreground watchPositionAsync callback
 * only updated local React state; the server POST lived exclusively in the
 * background-location task, which never starts unless the driver grants
 * "Always" location permission. A driver online in the foreground with
 * While-Using permission therefore had NO driver_locations row at all —
 * invisible to find_nearby_drivers, so dispatch never offered them anything.
 *
 * The foreground watch must ALSO heartbeat the server whenever the driver is
 * online, throttled, regardless of background permission.
 */

export type DriverOnlineStatus = 'offline' | 'available' | 'busy' | 'on_trip';

/** Server rejects location updates while offline — never send them. */
export function shouldSendHeartbeat(input: {
  status: DriverOnlineStatus;
  lastSentAt: number | null;
  now: number;
  throttleMs: number;
}): boolean {
  if (input.status === 'offline') return false;
  if (input.lastSentAt == null) return true;
  return input.now - input.lastSentAt >= input.throttleMs;
}

export interface HeartbeatPayload {
  lat: number;
  lng: number;
  heading?: number;
  speedKmh?: number;
  accuracyM?: number;
}

/**
 * API-schema-safe payload from raw device coords: heading is only valid in
 * [0, 360] (iOS reports -1 when unknown), speed only when non-negative
 * (m/s → km/h), accuracy only when non-negative (feeds the server-side trip
 * geofence gates).
 */
export function heartbeatPayload(coords: {
  latitude: number;
  longitude: number;
  heading?: number | null;
  speed?: number | null;
  accuracy?: number | null;
}): HeartbeatPayload {
  const payload: HeartbeatPayload = { lat: coords.latitude, lng: coords.longitude };
  if (coords.heading != null && coords.heading >= 0 && coords.heading <= 360) {
    payload.heading = coords.heading;
  }
  if (coords.speed != null && coords.speed >= 0) {
    payload.speedKmh = Math.round(coords.speed * 3.6 * 10) / 10;
  }
  if (coords.accuracy != null && coords.accuracy >= 0) {
    payload.accuracyM = Math.round(coords.accuracy * 10) / 10;
  }
  return payload;
}
