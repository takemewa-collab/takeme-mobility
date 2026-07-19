// ═══════════════════════════════════════════════════════════════════════════
// TAKEME MOBILITY — Multi-stop route points
// Validation and shared types for a ride's ordered itinerary:
// pickup → up to MAX_INTERMEDIATE_STOPS stops → dropoff.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from 'zod';

export const MAX_INTERMEDIATE_STOPS = 3;

export type RoutePointType = 'pickup' | 'stop' | 'dropoff';
export type RoutePointStatus = 'pending' | 'arrived' | 'completed' | 'skipped';

/** A route point as submitted by the rider client at booking time. */
export const routePointInputSchema = z.object({
  type: z.enum(['pickup', 'stop', 'dropoff']),
  seq: z.number().int().min(0).max(4),
  placeName: z.string().max(200).optional(),
  formattedAddress: z.string().min(1).max(500),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  providerPlaceId: z.string().max(200).optional(),
  legDistanceKm: z.number().min(0).max(1000).optional(),
  legDurationMin: z.number().int().min(0).max(1440).optional(),
});

export type RoutePointInput = z.infer<typeof routePointInputSchema>;

export const routePointsArraySchema = z
  .array(routePointInputSchema)
  .min(2)
  .max(2 + MAX_INTERMEDIATE_STOPS);

/** A route point as stored (snake_case, matches ride_route_points). */
export interface RoutePointRow {
  id: string;
  ride_id: string;
  point_type: RoutePointType;
  seq: number;
  place_name: string | null;
  formatted_address: string;
  lat: number;
  lng: number;
  provider_place_id: string | null;
  leg_distance_km: number | null;
  leg_duration_min: number | null;
  status: RoutePointStatus;
  arrived_at: string | null;
  completed_at: string | null;
}

const MIN_POINT_SEPARATION_KM = 0.01; // ~10 m — consecutive points must differ

export interface RouteValidationResult {
  ok: boolean;
  error?: string;
  /** Points sorted by seq when valid. */
  ordered?: RoutePointInput[];
}

/**
 * Structural validation of a client-submitted itinerary. Zod has already
 * checked field shapes; this enforces route semantics:
 * exactly one pickup (first), exactly one dropoff (last), 0–3 stops in
 * between, contiguous unique sequences, and no coincident consecutive points.
 */
export function validateRoutePoints(points: RoutePointInput[]): RouteValidationResult {
  const ordered = [...points].sort((a, b) => a.seq - b.seq);

  const seqs = new Set(ordered.map((p) => p.seq));
  if (seqs.size !== ordered.length) {
    return { ok: false, error: 'Duplicate route-point sequence numbers.' };
  }
  for (let i = 0; i < ordered.length; i++) {
    if (ordered[i].seq !== i) {
      return { ok: false, error: 'Route-point sequences must be contiguous from 0.' };
    }
  }

  const pickups = ordered.filter((p) => p.type === 'pickup');
  const dropoffs = ordered.filter((p) => p.type === 'dropoff');
  const stops = ordered.filter((p) => p.type === 'stop');

  if (pickups.length !== 1 || ordered[0].type !== 'pickup') {
    return { ok: false, error: 'Route must start with exactly one pickup.' };
  }
  if (dropoffs.length !== 1 || ordered[ordered.length - 1].type !== 'dropoff') {
    return { ok: false, error: 'Route must end with exactly one destination.' };
  }
  if (stops.length > MAX_INTERMEDIATE_STOPS) {
    return { ok: false, error: `A ride supports at most ${MAX_INTERMEDIATE_STOPS} stops.` };
  }

  for (const p of ordered) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng) || (p.lat === 0 && p.lng === 0)) {
      return { ok: false, error: 'A route point has invalid coordinates.' };
    }
  }

  for (let i = 1; i < ordered.length; i++) {
    if (haversineKm(ordered[i - 1], ordered[i]) < MIN_POINT_SEPARATION_KM) {
      return { ok: false, error: 'Consecutive route points are the same place.' };
    }
  }

  return { ok: true, ordered };
}

/**
 * Lower-bound sanity check for client-reported route totals: the driving
 * distance can never be shorter than the straight-line path through every
 * point, and a grossly inflated total is rejected too. This is a guard, not
 * the fare source — the fare itself is recomputed server-side.
 */
export function routeTotalsPlausible(points: RoutePointInput[], distanceKm: number): boolean {
  let straight = 0;
  for (let i = 1; i < points.length; i++) {
    straight += haversineKm(points[i - 1], points[i]);
  }
  // Roads are never shorter than the crow flies (small tolerance for rounding
  // and provider snap-to-road), and rarely 5× longer.
  return distanceKm >= straight * 0.9 && distanceKm <= Math.max(straight * 5, straight + 2);
}

export function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
