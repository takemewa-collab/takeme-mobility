// ═══════════════════════════════════════════════════════════════════════════
// TAKEME MOBILITY — Centralized Pricing Engine
// Single source of truth for all fare calculations.
// ═══════════════════════════════════════════════════════════════════════════

export type VehicleClass = 'economy' | 'comfort' | 'premium';

// ── Tier configuration ───────────────────────────────────────────────────

export interface TierConfig {
  id: VehicleClass;
  name: string;
  description: string;
  baseFare: number;       // flat fee per ride
  perKmRate: number;      // cost per kilometer
  perMinRate: number;     // cost per minute
  minFare: number;        // floor — rider never pays less than this
  bookingFee: number;     // platform fee
}

export const TIERS: Record<VehicleClass, TierConfig> = {
  economy: {
    id: 'economy',
    name: 'Economy',
    description: 'Affordable, reliable rides',
    baseFare: 2.50,
    perKmRate: 1.20,
    perMinRate: 0.20,
    minFare: 7.00,
    bookingFee: 1.50,
  },
  comfort: {
    id: 'comfort',
    name: 'Comfort',
    description: 'More space, newer vehicles',
    baseFare: 4.00,
    perKmRate: 1.80,
    perMinRate: 0.30,
    minFare: 12.00,
    bookingFee: 2.00,
  },
  premium: {
    id: 'premium',
    name: 'Premium',
    description: 'Luxury vehicles, professional drivers',
    baseFare: 6.00,
    perKmRate: 2.80,
    perMinRate: 0.45,
    minFare: 20.00,
    bookingFee: 2.50,
  },
};

export const ALL_TIERS: VehicleClass[] = ['economy', 'comfort', 'premium'];

// ── Surcharge rules (extensible) ─────────────────────────────────────────

export interface Surcharge {
  id: string;
  label: string;
  amount: number;        // flat amount added to fare
  appliesTo?: VehicleClass[];  // undefined = all tiers
}

// Placeholder for future airport/city surcharges.
// Add entries here — the engine applies them automatically.
export const SURCHARGES: Surcharge[] = [
  // { id: 'jfk_airport', label: 'Airport fee', amount: 5.00 },
  // { id: 'zurich_night', label: 'Night surcharge', amount: 3.00, appliesTo: ['economy', 'comfort'] },
];

// ── Multi-stop fee ───────────────────────────────────────────────────────
// Flat fee per intermediate stop, configurable via env so ops can tune it
// without a deploy of client apps. Like the booking fee it is NOT surged.
// NOTE: the rider app quotes with the same default client-side; if you
// override the env, redeploy pricing to the apps or fares will mismatch.

const DEFAULT_STOP_FEE = 1.5;

export function stopFeePerStop(): number {
  const raw = Number(process.env.MULTI_STOP_FEE_USD);
  return Number.isFinite(raw) && raw >= 0 && raw <= 20 ? raw : DEFAULT_STOP_FEE;
}

// ── Fare calculation ─────────────────────────────────────────────────────

export interface FareBreakdown {
  baseFare: number;
  distanceFare: number;
  timeFare: number;
  bookingFee: number;
  /** Flat multi-stop fee: stopCount × stopFeePerStop(). 0 for direct trips. */
  stopFee: number;
  surcharges: { id: string; label: string; amount: number }[];
  surchargeTotal: number;
  subtotal: number;
  surgeMultiplier: number;
  total: number;          // final amount the rider pays
  currency: string;
  minFareApplied: boolean;
}

export interface QuoteResult {
  vehicleClass: VehicleClass;
  tierName: string;
  tierDescription: string;
  fare: FareBreakdown;
  distanceKm: number;
  durationMin: number;
}

export function calculateFare(
  tier: TierConfig,
  distanceKm: number,
  durationMin: number,
  opts: {
    surgeMultiplier?: number;
    surchargeIds?: string[];
    currency?: string;
    /** Number of intermediate stops on the route (0 for a direct trip). */
    stopCount?: number;
  } = {},
): FareBreakdown {
  const surge = opts.surgeMultiplier ?? 1.0;
  const currency = opts.currency ?? 'USD';

  const baseFare = tier.baseFare;
  const distanceFare = round2(distanceKm * tier.perKmRate);
  const timeFare = round2(durationMin * tier.perMinRate);
  const bookingFee = tier.bookingFee;
  const stopFee = round2(Math.max(0, opts.stopCount ?? 0) * stopFeePerStop());

  // Apply surcharges
  const activeSurcharges = SURCHARGES.filter(s => {
    if (opts.surchargeIds && !opts.surchargeIds.includes(s.id)) return false;
    if (s.appliesTo && !s.appliesTo.includes(tier.id)) return false;
    return true;
  });
  const surchargeTotal = round2(activeSurcharges.reduce((sum, s) => sum + s.amount, 0));

  // Apply surge to ride cost (not booking fee, stop fee, or surcharges)
  const rideCost = (baseFare + distanceFare + timeFare) * surge;
  const subtotal = round2(rideCost + bookingFee + stopFee + surchargeTotal);

  // Enforce minimum fare
  const minFareApplied = subtotal < tier.minFare;
  const total = round2(Math.max(subtotal, tier.minFare));

  return {
    baseFare,
    distanceFare,
    timeFare,
    bookingFee,
    stopFee,
    surcharges: activeSurcharges.map(s => ({ id: s.id, label: s.label, amount: s.amount })),
    surchargeTotal,
    subtotal,
    surgeMultiplier: surge,
    total,
    currency,
    minFareApplied,
  };
}

/**
 * Generate quotes for all tiers given a route.
 */
export function generateQuotes(
  distanceKm: number,
  durationMin: number,
  opts: {
    surgeMultiplier?: number;
    surchargeIds?: string[];
    currency?: string;
    stopCount?: number;
  } = {},
): QuoteResult[] {
  return ALL_TIERS.map(cls => {
    const tier = TIERS[cls];
    return {
      vehicleClass: cls,
      tierName: tier.name,
      tierDescription: tier.description,
      fare: calculateFare(tier, distanceKm, durationMin, opts),
      distanceKm,
      durationMin,
    };
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
