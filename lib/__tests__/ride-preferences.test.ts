import { describe, expect, it } from 'vitest';
import {
  activePetFee,
  applyPreferenceFilters,
  resolvePreferenceConfig,
  ridePreferencesSchema,
  validatePreferences,
  type PreferenceConfigRow,
  type ResolvedPreferenceConfig,
} from '../ride-preferences';
import {
  rankDrivers,
  selectBestDriver,
  stablePreferEnrolled,
  type DriverCandidate,
} from '../matching';
import { TIERS, calculateFare, stopFeePerStop } from '../pricing';

const round2 = (n: number) => Math.round(n * 100) / 100;

// ── Fixtures ─────────────────────────────────────────────────────────────

function configRow(overrides: Partial<PreferenceConfigRow> = {}): PreferenceConfigRow {
  return {
    preference: 'pet_friendly',
    state_code: null,
    enabled: true,
    fee: 4,
    fee_effective_from: null,
    fee_effective_to: null,
    rules: {},
    copy_version: 'v1',
    fallback_default: 'any_driver',
    ...overrides,
  };
}

function resolved(
  pet: PreferenceConfigRow | null,
  women: PreferenceConfigRow | null,
): ResolvedPreferenceConfig {
  return { petFriendly: pet, womenPreferred: women };
}

function candidate(overrides: Partial<DriverCandidate> = {}): DriverCandidate {
  return {
    driver_id: 'd1',
    driver_name: 'Driver',
    driver_rating: 4.8,
    vehicle_id: 'v1',
    vehicle_make: 'Kia',
    vehicle_model: 'Niro',
    vehicle_color: 'Blue',
    plate_number: 'AAA111',
    distance_m: 1000,
    heading: null,
    lat: 47.6,
    lng: -122.3,
    ...overrides,
  };
}

// ── Config precedence ────────────────────────────────────────────────────

describe('resolvePreferenceConfig', () => {
  const defaultPet = configRow({ fee: 4 });
  const waPet = configRow({ state_code: 'WA', fee: 6 });
  const defaultWomen = configRow({ preference: 'women_preferred', fee: null });

  it('state row overrides the default row', () => {
    const cfg = resolvePreferenceConfig([defaultPet, waPet, defaultWomen], 'WA');
    expect(cfg.petFriendly?.fee).toBe(6);
    expect(cfg.petFriendly?.state_code).toBe('WA');
  });

  it('falls back to the default row when no state row exists', () => {
    const cfg = resolvePreferenceConfig([defaultPet, waPet, defaultWomen], 'OR');
    expect(cfg.petFriendly?.fee).toBe(4);
    expect(cfg.petFriendly?.state_code).toBeNull();
    expect(cfg.womenPreferred?.preference).toBe('women_preferred');
  });

  it('uses the default row for a null state and null when nothing matches', () => {
    const cfg = resolvePreferenceConfig([waPet], null);
    expect(cfg.petFriendly).toBeNull();
    expect(cfg.womenPreferred).toBeNull();
  });
});

// ── Effective-dated pet fee ──────────────────────────────────────────────

describe('activePetFee', () => {
  const at = new Date('2026-07-19T12:00:00Z');

  it('returns the fee when no window is set', () => {
    expect(activePetFee(resolved(configRow({ fee: 4 }), null), at)).toBe(4);
  });

  it('returns null before the effective-from instant', () => {
    const row = configRow({ fee: 4, fee_effective_from: '2026-08-01T00:00:00Z' });
    expect(activePetFee(resolved(row, null), at)).toBeNull();
  });

  it('returns null at/after the effective-to instant', () => {
    const row = configRow({ fee: 4, fee_effective_to: '2026-07-19T12:00:00Z' });
    expect(activePetFee(resolved(row, null), at)).toBeNull();
  });

  it('returns the fee inside an open window', () => {
    const row = configRow({
      fee: 5.5,
      fee_effective_from: '2026-07-01T00:00:00Z',
      fee_effective_to: '2026-08-01T00:00:00Z',
    });
    expect(activePetFee(resolved(row, null), at)).toBe(5.5);
  });

  it('returns null when the preference is disabled or the fee is unset', () => {
    expect(activePetFee(resolved(configRow({ enabled: false }), null), at)).toBeNull();
    expect(activePetFee(resolved(configRow({ fee: null }), null), at)).toBeNull();
    expect(activePetFee(resolved(null, null), at)).toBeNull();
  });
});

// ── Pet fee fare math ────────────────────────────────────────────────────

describe('pet fee fare math', () => {
  const tier = TIERS.economy;
  const km = 10;
  const min = 20;

  it('adds the flat pet fee on top of the fare', () => {
    const direct = calculateFare(tier, km, min);
    const withPet = calculateFare(tier, km, min, { petFee: 4 });
    expect(withPet.petFee).toBe(4);
    expect(withPet.total).toBe(round2(direct.total + 4));
    expect(withPet.subtotal).toBe(round2(direct.subtotal + 4));
  });

  it('does not surge the pet fee', () => {
    const surged = calculateFare(tier, km, min, { petFee: 4, surgeMultiplier: 2.0 });
    const rideCost = (tier.baseFare + round2(km * tier.perKmRate) + round2(min * tier.perMinRate)) * 2.0;
    const expected = round2(rideCost + tier.bookingFee + 4);
    expect(surged.total).toBe(round2(Math.max(expected, tier.minFare)));
    expect(surged.petFee).toBe(4);
  });

  it('stacks with stop and airport fees, all unsurged', () => {
    const fare = calculateFare(tier, km, min, {
      petFee: 4,
      stopCount: 2,
      airportFees: 4.5,
      surgeMultiplier: 1.5,
    });
    const rideCost = (tier.baseFare + round2(km * tier.perKmRate) + round2(min * tier.perMinRate)) * 1.5;
    const expected = round2(rideCost + tier.bookingFee + round2(2 * stopFeePerStop()) + 4.5 + 4);
    expect(fare.total).toBe(round2(Math.max(expected, tier.minFare)));
  });

  it('keeps the minimum-fare floor for a tiny trip with a pet fee', () => {
    const fare = calculateFare(tier, 0.2, 1, { petFee: 4 });
    expect(fare.total).toBeGreaterThanOrEqual(tier.minFare);
    expect(fare.minFareApplied).toBe(fare.total === tier.minFare);
  });

  it('defaults to zero and ignores negative amounts', () => {
    const a = calculateFare(tier, km, min);
    expect(a.petFee).toBe(0);
    const b = calculateFare(tier, km, min, { petFee: -3 });
    expect(b.petFee).toBe(0);
    expect(b.total).toBe(a.total);
  });
});

// ── Zod schema ───────────────────────────────────────────────────────────

describe('ridePreferencesSchema', () => {
  it('accepts the documented shape', () => {
    const parsed = ridePreferencesSchema.parse({
      womenPreferred: true,
      petFriendly: true,
      fallback: 'keep_looking',
    });
    expect(parsed.fallback).toBe('keep_looking');
  });

  it('rejects unknown keys', () => {
    expect(() => ridePreferencesSchema.parse({ petFriendly: true, freeRides: true })).toThrow();
  });

  it('rejects invalid fallback values and non-boolean flags', () => {
    expect(() => ridePreferencesSchema.parse({ fallback: 'whatever' })).toThrow();
    expect(() => ridePreferencesSchema.parse({ petFriendly: 'yes' })).toThrow();
  });
});

// ── validatePreferences ──────────────────────────────────────────────────

describe('validatePreferences', () => {
  const enabledConfig = resolved(
    configRow({ fee: 4 }),
    configRow({ preference: 'women_preferred', fee: null, fallback_default: 'any_driver' }),
  );

  it('no selection → nothing stored, nothing charged', () => {
    const r = validatePreferences(enabledConfig, {});
    expect(r).toEqual({ ok: true, stored: null, petFee: null });
    const r2 = validatePreferences(enabledConfig, undefined);
    expect(r2).toEqual({ ok: true, stored: null, petFee: null });
  });

  it('rejects a pet_friendly request when the preference is disabled', () => {
    const cfg = resolved(configRow({ enabled: false }), enabledConfig.womenPreferred);
    const r = validatePreferences(cfg, { petFriendly: true });
    expect(r.ok).toBe(false);
  });

  it('rejects a women_preferred request when the preference is disabled/absent', () => {
    const cfg = resolved(enabledConfig.petFriendly, null);
    const r = validatePreferences(cfg, { womenPreferred: true });
    expect(r.ok).toBe(false);
  });

  it('normalizes the stored snapshot and resolves the pet fee from config', () => {
    const r = validatePreferences(enabledConfig, { womenPreferred: true, petFriendly: true });
    expect(r).toEqual({
      ok: true,
      stored: { women_preferred: true, fallback: 'any_driver', pet_friendly: true },
      petFee: 4,
    });
  });

  it('honors an explicit fallback and the config default otherwise', () => {
    const explicit = validatePreferences(enabledConfig, {
      womenPreferred: true,
      fallback: 'keep_looking',
    });
    expect(explicit.ok && explicit.stored?.fallback).toBe('keep_looking');

    const cfg = resolved(
      enabledConfig.petFriendly,
      configRow({ preference: 'women_preferred', fallback_default: 'keep_looking' }),
    );
    const fromDefault = validatePreferences(cfg, { womenPreferred: true });
    expect(fromDefault.ok && fromDefault.stored?.fallback).toBe('keep_looking');
  });

  it('never charges a pet fee without an explicit petFriendly selection', () => {
    // Service-animal guarantee: women_preferred alone must not carry a fee.
    const r = validatePreferences(enabledConfig, { womenPreferred: true });
    expect(r.ok && r.petFee).toBeNull();
    if (r.ok) expect(r.stored?.pet_friendly).toBeUndefined();
  });
});

// ── Matching: prioritize + hard filters ──────────────────────────────────

describe('women_preferred matching', () => {
  // far + enrolled scores lower than near + not-enrolled on raw distance.
  const near = candidate({ driver_id: 'near', distance_m: 500, women_preferred_enrolled: false });
  const mid = candidate({ driver_id: 'mid', distance_m: 2000, women_preferred_enrolled: true });
  const far = candidate({ driver_id: 'far', distance_m: 8000, women_preferred_enrolled: true });

  it('selectBestDriver picks the best-scored enrolled driver when preferring', () => {
    const best = selectBestDriver([near, mid, far], 47.6, -122.3, { preferWomenEnrolled: true });
    expect(best?.driver_id).toBe('mid');
  });

  it('selectBestDriver is unchanged without the option', () => {
    const best = selectBestDriver([near, mid, far], 47.6, -122.3);
    expect(best?.driver_id).toBe('near');
  });

  it('rankDrivers stable-sorts enrolled first, preserving score order in each group', () => {
    const ranked = rankDrivers([near, mid, far], 47.6, -122.3, 10000, {
      preferWomenEnrolled: true,
    });
    expect(ranked.map((d) => d.driver_id)).toEqual(['mid', 'far', 'near']);
  });

  it('stablePreferEnrolled preserves relative order within both groups', () => {
    const list = [
      { id: 'a', women_preferred_enrolled: false },
      { id: 'b', women_preferred_enrolled: true },
      { id: 'c', women_preferred_enrolled: false },
      { id: 'd', women_preferred_enrolled: true },
    ];
    expect(stablePreferEnrolled(list).map((d) => d.id)).toEqual(['b', 'd', 'a', 'c']);
  });
});

describe('applyPreferenceFilters', () => {
  const optedIn = candidate({ driver_id: 'p1', pet_friendly_opt_in: true });
  const notOpted = candidate({ driver_id: 'p2', pet_friendly_opt_in: false });
  const enrolled = candidate({ driver_id: 'w1', women_preferred_enrolled: true });
  const notEnrolled = candidate({ driver_id: 'w2', women_preferred_enrolled: false });

  it('pet_friendly hard-filters to opted-in drivers', () => {
    const out = applyPreferenceFilters([optedIn, notOpted], { pet_friendly: true });
    expect(out.map((d) => d.driver_id)).toEqual(['p1']);
  });

  it('keep_looking hard-filters to enrolled drivers (empty when none exist)', () => {
    const out = applyPreferenceFilters([enrolled, notEnrolled], {
      women_preferred: true,
      fallback: 'keep_looking',
    });
    expect(out.map((d) => d.driver_id)).toEqual(['w1']);

    // No enrolled driver → no candidates: the ride keeps looking and follows
    // the normal escalation/no-driver path — never a silent non-enrolled match.
    const none = applyPreferenceFilters([notEnrolled], {
      women_preferred: true,
      fallback: 'keep_looking',
    });
    expect(none).toEqual([]);
  });

  it('any_driver never filters on enrollment', () => {
    const out = applyPreferenceFilters([notEnrolled, enrolled], {
      women_preferred: true,
      fallback: 'any_driver',
    });
    expect(out).toHaveLength(2);
  });

  it('no preferences → candidates pass through untouched', () => {
    const list = [optedIn, notOpted, enrolled];
    expect(applyPreferenceFilters(list, null)).toBe(list);
    expect(applyPreferenceFilters(list, {})).toEqual(list);
  });

  it('stacked preferences apply both filters', () => {
    const both = candidate({
      driver_id: 'both',
      pet_friendly_opt_in: true,
      women_preferred_enrolled: true,
    });
    const out = applyPreferenceFilters([optedIn, both, enrolled], {
      pet_friendly: true,
      women_preferred: true,
      fallback: 'keep_looking',
    });
    expect(out.map((d) => d.driver_id)).toEqual(['both']);
  });
});
