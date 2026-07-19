// ═══════════════════════════════════════════════════════════════════════════
// TAKEME MOBILITY — Smart Driver Matching Algorithm
// Scores drivers on multiple factors instead of nearest-first greedy.
//
// Scoring factors:
//   - Distance to pickup (40% weight) — closer is better
//   - Driver heading alignment (20%) — driving toward pickup is better
//   - Driver rating (15%) — higher rated drivers preferred
//   - Acceptance rate (15%) — more reliable drivers preferred
//   - Trip count (10%) — fair distribution, fewer trips today = bonus
//
// Returns ranked list of drivers with scores.
// ═══════════════════════════════════════════════════════════════════════════

export interface DriverCandidate {
  driver_id: string;
  driver_name: string;
  driver_rating: number;
  vehicle_id: string;
  vehicle_make: string;
  vehicle_model: string;
  vehicle_color: string;
  plate_number: string;
  distance_m: number;
  heading: number | null;
  lat: number;
  lng: number;
  // Enhanced fields (may be null for basic queries)
  total_trips?: number;
  acceptance_rate?: number;
  trips_today?: number;
  // Preference participation flags (service-role lookups in dispatch;
  // absent for basic queries — treated as "not participating").
  pet_friendly_opt_in?: boolean;
  women_preferred_enrolled?: boolean;
}

export interface MatchOptions {
  /**
   * Women Preferred with fallback 'any_driver': enrolled drivers are
   * stable-sorted to the front of the ranked list. This PRIORITIZES — it
   * never excludes non-enrolled drivers (hard filtering only happens for
   * fallback 'keep_looking', in lib/ride-preferences applyPreferenceFilters).
   */
  preferWomenEnrolled?: boolean;
}

interface ScoredDriver extends DriverCandidate {
  score: number;
  breakdown: {
    distanceScore: number;
    headingScore: number;
    ratingScore: number;
    acceptanceScore: number;
    fairnessScore: number;
  };
}

// Weights must sum to 1.0
const WEIGHTS = {
  distance: 0.40,
  heading: 0.20,
  rating: 0.15,
  acceptance: 0.15,
  fairness: 0.10,
};

/**
 * Score a single driver candidate.
 * All scores are normalized to 0-1 range (higher = better).
 */
function scoreDriver(
  driver: DriverCandidate,
  pickupLat: number,
  pickupLng: number,
  maxDistanceM: number,
): ScoredDriver {
  // 1. Distance score: closer = higher score (inverse normalized)
  const distanceScore = Math.max(0, 1 - (driver.distance_m / maxDistanceM));

  // 2. Heading alignment: is driver driving toward pickup?
  let headingScore = 0.5; // neutral if no heading data
  if (driver.heading !== null && driver.lat && driver.lng) {
    const bearingToPickup = calculateBearing(driver.lat, driver.lng, pickupLat, pickupLng);
    const headingDiff = Math.abs(normalizeAngle(driver.heading - bearingToPickup));
    // 0° diff = perfect (1.0), 180° diff = worst (0.0)
    headingScore = Math.max(0, 1 - (headingDiff / 180));
  }

  // 3. Rating score: normalized (assuming 1-5 range)
  const ratingScore = Math.max(0, (driver.driver_rating - 1) / 4);

  // 4. Acceptance rate: default 0.8 if unknown
  const acceptanceScore = (driver.acceptance_rate ?? 80) / 100;

  // 5. Fairness: fewer trips today = higher bonus
  const tripsToday = driver.trips_today ?? 0;
  const fairnessScore = Math.max(0, 1 - (tripsToday / 20)); // 20 trips = no bonus

  // Weighted sum
  const score =
    WEIGHTS.distance * distanceScore +
    WEIGHTS.heading * headingScore +
    WEIGHTS.rating * ratingScore +
    WEIGHTS.acceptance * acceptanceScore +
    WEIGHTS.fairness * fairnessScore;

  return {
    ...driver,
    score,
    breakdown: {
      distanceScore,
      headingScore,
      ratingScore,
      acceptanceScore,
      fairnessScore,
    },
  };
}

/**
 * Stable partition: enrolled Women Preferred drivers first, everyone else
 * after, relative order preserved within each group. Pure — unit tested.
 */
export function stablePreferEnrolled<T extends { women_preferred_enrolled?: boolean }>(
  list: T[],
): T[] {
  return [
    ...list.filter(d => d.women_preferred_enrolled === true),
    ...list.filter(d => d.women_preferred_enrolled !== true),
  ];
}

/**
 * Rank drivers by smart matching score.
 * Returns sorted array (best match first).
 */
export function rankDrivers(
  candidates: DriverCandidate[],
  pickupLat: number,
  pickupLng: number,
  maxDistanceM: number = 10000,
  opts: MatchOptions = {},
): ScoredDriver[] {
  if (candidates.length === 0) return [];

  const scored = candidates.map(d => scoreDriver(d, pickupLat, pickupLng, maxDistanceM));
  scored.sort((a, b) => b.score - a.score);

  // Women Preferred prioritization: a stable pass AFTER scoring, so enrolled
  // drivers lead while score order is preserved within each group.
  return opts.preferWomenEnrolled ? stablePreferEnrolled(scored) : scored;
}

/**
 * Select the best driver from candidates.
 */
export function selectBestDriver(
  candidates: DriverCandidate[],
  pickupLat: number,
  pickupLng: number,
  opts: MatchOptions = {},
): ScoredDriver | null {
  const ranked = rankDrivers(candidates, pickupLat, pickupLng, 10000, opts);
  return ranked[0] ?? null;
}

// ── Geo helpers ──────────────────────────────────────────────────────────

function calculateBearing(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const toDeg = (rad: number) => (rad * 180) / Math.PI;

  const dLng = toRad(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);

  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function normalizeAngle(angle: number): number {
  while (angle > 180) angle -= 360;
  while (angle < -180) angle += 360;
  return angle;
}
