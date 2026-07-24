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

/**
 * Should the stationary-heartbeat timer fire a beat right now?
 *
 * watchPositionAsync's timeInterval is ANDROID-ONLY: on iOS, callbacks come
 * from movement (distanceInterval) — a parked driver gets none, sends no
 * heartbeats, exceeds the server's location-freshness window, and silently
 * becomes invisible to matching ("No Drivers Available" beside an online
 * driver). The timer covers exactly that gap: it beats only when the watch
 * has NOT recently heartbeat on its own.
 */
export function shouldRunStationaryBeat(input: {
  status: DriverOnlineStatus;
  lastSentAt: number | null;
  now: number;
  intervalMs: number;
}): boolean {
  if (input.status === 'offline') return false;
  if (input.lastSentAt == null) return true;
  return input.now - input.lastSentAt >= input.intervalMs;
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
