// ═══════════════════════════════════════════════════════════════════════════
// TAKEME MOBILITY — Route Service (Server-side)
// Calculates route distance/duration via Google Directions API.
// Used by the quote endpoint. Runs server-side only (uses secret key).
// ═══════════════════════════════════════════════════════════════════════════

import { TTLCache } from '@/lib/cache';

// Cache routes for 15 min, geocoding for 1 hour
const routeCache = new TTLCache<RouteResult>(500, 15 * 60 * 1000);
const geocodeCache = new TTLCache<{ lat: number; lng: number; formattedAddress: string }>(1000, 60 * 60 * 1000);

// Round coordinates to ~100m grid for cache key (3 decimal places)
function roundCoord(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export interface RouteInput {
  pickupLat: number;
  pickupLng: number;
  dropoffLat: number;
  dropoffLng: number;
  /** Ordered intermediate stops between pickup and dropoff (max 3). */
  waypoints?: { lat: number; lng: number }[];
}

export interface RouteLeg {
  distanceKm: number;
  durationMin: number;
}

export interface RouteResult {
  distanceKm: number;
  durationMin: number;
  polyline: string;
  pickupAddress: string;
  dropoffAddress: string;
  /** One leg per hop: pickup→stop1, …, lastStop→dropoff. Single leg when no waypoints. */
  legs: RouteLeg[];
}

const GOOGLE_MAPS_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';

/**
 * Resolve route via Google Directions API (server-side fetch).
 * Returns distance in km, duration in minutes, and encoded polyline.
 */
export async function calculateRoute(input: RouteInput): Promise<RouteResult> {
  if (!GOOGLE_MAPS_KEY) {
    throw new Error('GOOGLE_MAPS_API_KEY is not configured');
  }

  const waypoints = input.waypoints ?? [];

  // Check cache (rounded to ~100m grid, waypoints included in the key)
  const cacheKey = [
    `${roundCoord(input.pickupLat)},${roundCoord(input.pickupLng)}`,
    ...waypoints.map((w) => `${roundCoord(w.lat)},${roundCoord(w.lng)}`),
    `${roundCoord(input.dropoffLat)},${roundCoord(input.dropoffLng)}`,
  ].join('-');
  const cached = routeCache.get(cacheKey);
  if (cached) return cached;

  const origin = `${input.pickupLat},${input.pickupLng}`;
  const destination = `${input.dropoffLat},${input.dropoffLng}`;

  const url = new URL('https://maps.googleapis.com/maps/api/directions/json');
  url.searchParams.set('origin', origin);
  url.searchParams.set('destination', destination);
  if (waypoints.length > 0) {
    // No "optimize:true" — the rider's chosen stop order is never reshuffled.
    url.searchParams.set('waypoints', waypoints.map((w) => `${w.lat},${w.lng}`).join('|'));
  }
  url.searchParams.set('mode', 'driving');
  url.searchParams.set('key', GOOGLE_MAPS_KEY);

  const res = await fetch(url.toString(), { next: { revalidate: 0 } });
  if (!res.ok) {
    throw new Error(`Google Directions API error: ${res.status}`);
  }

  const data = await res.json();

  if (data.status !== 'OK' || !data.routes?.length) {
    throw new Error(`No route found: ${data.status}`);
  }

  const route = data.routes[0];
  const rawLegs: { distance?: { value?: number }; duration?: { value?: number }; start_address?: string; end_address?: string }[] =
    route.legs ?? [];

  // With N waypoints Google returns N+1 legs, in submitted order.
  if (rawLegs.length !== waypoints.length + 1) {
    throw new Error(`Route returned ${rawLegs.length} legs for ${waypoints.length} waypoints`);
  }
  for (const leg of rawLegs) {
    if (!leg?.distance?.value || !leg?.duration?.value) {
      throw new Error('Route returned invalid distance/duration');
    }
  }

  const legs: RouteLeg[] = rawLegs.map((leg) => ({
    distanceKm: Math.round(((leg.distance!.value as number) / 1000) * 100) / 100,
    durationMin: Math.ceil((leg.duration!.value as number) / 60),
  }));

  const result: RouteResult = {
    distanceKm: Math.round(legs.reduce((s, l) => s + l.distanceKm, 0) * 100) / 100,
    durationMin: legs.reduce((s, l) => s + l.durationMin, 0),
    polyline: route.overview_polyline?.points ?? '',
    pickupAddress: rawLegs[0]?.start_address ?? '',
    dropoffAddress: rawLegs[rawLegs.length - 1]?.end_address ?? '',
    legs,
  };

  routeCache.set(cacheKey, result);
  return result;
}

/**
 * Geocode an address string to lat/lng.
 * Used when the client sends address text instead of coordinates.
 */
export async function geocodeAddress(address: string): Promise<{ lat: number; lng: number; formattedAddress: string }> {
  if (!GOOGLE_MAPS_KEY) {
    throw new Error('GOOGLE_MAPS_API_KEY is not configured');
  }

  // Check cache
  const cacheKey = address.trim().toLowerCase();
  const cached = geocodeCache.get(cacheKey);
  if (cached) return cached;

  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('address', address);
  url.searchParams.set('key', GOOGLE_MAPS_KEY);

  const res = await fetch(url.toString(), { next: { revalidate: 0 } });
  if (!res.ok) {
    throw new Error(`Google Geocoding API error: ${res.status}`);
  }

  const data = await res.json();

  if (data.status !== 'OK' || !data.results?.length) {
    throw new Error(`Geocoding failed: ${data.status}`);
  }

  const geoResult = data.results[0];
  const geocoded = {
    lat: geoResult.geometry.location.lat,
    lng: geoResult.geometry.location.lng,
    formattedAddress: geoResult.formatted_address,
  };

  geocodeCache.set(cacheKey, geocoded);
  return geocoded;
}
