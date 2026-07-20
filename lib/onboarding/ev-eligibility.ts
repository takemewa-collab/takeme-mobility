/**
 * EV eligibility — market policy applied to decoded vehicle facts.
 * Policy lives in onboarding_markets.policies.ev; nothing is hardcoded here.
 */
import type { EvEligibilityResult, EvPolicy, VehicleFacts } from './types';

export function checkEvEligibility(
  facts: VehicleFacts,
  policy: EvPolicy,
  now: Date,
): EvEligibilityResult {
  const reasons: string[] = [];
  let needsReview = false;

  if (policy.require_battery_electric !== false) {
    if (facts.powertrain === 'unknown') {
      needsReview = true;
      reasons.push('powertrain_unverified');
    } else if (facts.powertrain !== 'bev') {
      reasons.push('not_battery_electric');
    }
  }

  if (facts.year == null) {
    needsReview = true;
    reasons.push('model_year_unknown');
  } else {
    if (policy.min_model_year && facts.year < policy.min_model_year) {
      reasons.push('below_min_model_year');
    }
    if (
      policy.max_vehicle_age_years &&
      now.getFullYear() - facts.year > policy.max_vehicle_age_years
    ) {
      reasons.push('exceeds_max_vehicle_age');
    }
  }

  if (policy.min_doors && facts.doors != null && facts.doors < policy.min_doors) {
    reasons.push('too_few_doors');
  }
  if (policy.min_seatbelts && facts.seatbelts != null && facts.seatbelts < policy.min_seatbelts) {
    reasons.push('too_few_seatbelts');
  }

  const hardFailure = reasons.some(
    (r) => !['powertrain_unverified', 'model_year_unknown'].includes(r),
  );
  return {
    eligible: reasons.length === 0,
    reasons,
    needsReview: !hardFailure && needsReview,
  };
}

/** Normalize NHTSA vPIC fuel/EV fields into our powertrain vocabulary. */
export function normalizePowertrain(fields: {
  FuelTypePrimary?: string;
  FuelTypeSecondary?: string;
  ElectrificationLevel?: string;
}): string {
  const level = (fields.ElectrificationLevel ?? '').toLowerCase();
  const primary = (fields.FuelTypePrimary ?? '').toLowerCase();
  const secondary = (fields.FuelTypeSecondary ?? '').toLowerCase();

  if (level.includes('bev') || level.includes('battery electric')) return 'bev';
  if (level.includes('phev') || level.includes('plug-in')) return 'phev';
  if (level.includes('hev') || level.includes('mild') || level.includes('strong')) return 'hev';
  if (primary.includes('electric') && !secondary) return 'bev';
  if (primary.includes('electric') || secondary.includes('electric')) return 'phev';
  if (primary === '' && secondary === '') return 'unknown';
  return 'ice';
}
