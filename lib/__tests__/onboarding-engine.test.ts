import { describe, expect, it } from 'vitest';
import {
  applicableDefinitions,
  backgroundRequirementStatus,
  computeActivation,
  effectiveStatus,
  nextAction,
  withDependencyBlocking,
} from '../onboarding/engine';
import { checkEvEligibility, normalizePowertrain } from '../onboarding/ev-eligibility';
import { normalizePlate, normalizeVin } from '../onboarding/vin';
import type {
  ApplicationRequirementRow,
  RequirementDefinition,
  RequirementStatus,
} from '../onboarding/types';

const NOW = new Date('2026-07-20T12:00:00Z');

function def(overrides: Partial<RequirementDefinition>): RequirementDefinition {
  return {
    id: overrides.key ?? 'id',
    key: 'k',
    market_id: null,
    applicant_types: null,
    vehicle_relationships: null,
    category: 'identity',
    required: true,
    blocking: true,
    review_method: 'document_review',
    title: 'T',
    summary: '',
    instructions: '',
    external_url: null,
    doc_kinds: null,
    depends_on: null,
    config: {},
    sort_order: 100,
    active: true,
    ...overrides,
  };
}

function req(
  key: string,
  status: RequirementStatus,
  extra: Partial<ApplicationRequirementRow> = {},
): ApplicationRequirementRow {
  return {
    id: key,
    application_id: 'app',
    definition_id: key,
    requirement_key: key,
    status,
    required: true,
    blocking: true,
    due_at: null,
    expires_at: null,
    rejection_reason: null,
    review_note: null,
    metadata: {},
    updated_at: NOW.toISOString(),
    ...extra,
  };
}

describe('applicableDefinitions', () => {
  const defs = [
    def({ key: 'global', sort_order: 10 }),
    def({ key: 'livery_only', applicant_types: ['livery_operator', 'subcarrier'], sort_order: 20 }),
    def({ key: 'personal_vehicle', vehicle_relationships: ['personal_owned', 'personal_leased'], sort_order: 30 }),
    def({ key: 'seattle_only', market_id: 'sea', sort_order: 40 }),
    def({ key: 'inactive', active: false }),
  ];

  it('gives an ordinary Seattle owner only global + personal + market requirements', () => {
    const out = applicableDefinitions(defs, {
      applicantType: 'individual_owner',
      vehicleRelationship: 'personal_owned',
      marketId: 'sea',
    });
    expect(out.map((d) => d.key)).toEqual(['global', 'personal_vehicle', 'seattle_only']);
  });

  it('never shows livery requirements to ordinary drivers', () => {
    const out = applicableDefinitions(defs, {
      applicantType: 'individual_owner',
      vehicleRelationship: 'personal_owned',
      marketId: 'sea',
    });
    expect(out.find((d) => d.key === 'livery_only')).toBeUndefined();
  });

  it('shows livery requirements to livery operators', () => {
    const out = applicableDefinitions(defs, {
      applicantType: 'livery_operator',
      vehicleRelationship: 'commercial_livery',
      marketId: 'sea',
    });
    expect(out.map((d) => d.key)).toContain('livery_only');
  });

  it('excludes other-market definitions', () => {
    const out = applicableDefinitions(defs, {
      applicantType: 'individual_owner',
      vehicleRelationship: 'personal_owned',
      marketId: 'pdx',
    });
    expect(out.find((d) => d.key === 'seattle_only')).toBeUndefined();
  });

  it('skips relationship-scoped defs when the applicant has no vehicle relationship yet', () => {
    const out = applicableDefinitions(defs, {
      applicantType: 'rental_seeker',
      vehicleRelationship: null,
      marketId: 'sea',
    });
    expect(out.find((d) => d.key === 'personal_vehicle')).toBeUndefined();
  });

  it('excludes inactive definitions', () => {
    const out = applicableDefinitions(defs, {
      applicantType: 'individual_owner',
      vehicleRelationship: 'personal_owned',
      marketId: null,
    });
    expect(out.find((d) => d.key === 'inactive')).toBeUndefined();
  });
});

describe('effectiveStatus / expiry', () => {
  it('approved with future expiry stays approved', () => {
    expect(
      effectiveStatus({ status: 'approved', expires_at: '2026-12-01T00:00:00Z' }, 30, NOW),
    ).toBe('approved');
  });
  it('approved inside the renewal window becomes expiring_soon', () => {
    expect(
      effectiveStatus({ status: 'approved', expires_at: '2026-08-01T00:00:00Z' }, 30, NOW),
    ).toBe('expiring_soon');
  });
  it('approved past expiry becomes expired', () => {
    expect(
      effectiveStatus({ status: 'approved', expires_at: '2026-07-01T00:00:00Z' }, 30, NOW),
    ).toBe('expired');
  });
});

describe('withDependencyBlocking', () => {
  const defs = new Map([
    ['license', def({ key: 'license' })],
    ['photo', def({ key: 'photo', depends_on: ['license'] })],
  ]);
  it('blocks dependent steps until the dependency is satisfied', () => {
    const out = withDependencyBlocking(
      [req('license', 'not_started'), req('photo', 'not_started')],
      defs,
    );
    expect(out.get('photo')).toBe('blocked');
  });
  it('unblocks once the dependency is approved', () => {
    const out = withDependencyBlocking(
      [req('license', 'approved'), req('photo', 'not_started')],
      defs,
    );
    expect(out.get('photo')).toBe('not_started');
  });
  it('never blocks an already-approved requirement', () => {
    const out = withDependencyBlocking(
      [req('license', 'rejected'), req('photo', 'approved')],
      defs,
    );
    expect(out.get('photo')).toBe('approved');
  });
});

describe('computeActivation', () => {
  it('is eligible only when every blocking requirement is satisfied', () => {
    const out = computeActivation({
      applicationStatus: 'pending',
      requirements: [req('a', 'approved'), req('b', 'waived'), req('c', 'not_applicable')],
      driver: null,
      now: NOW,
    });
    expect(out.decision).toBe('eligible');
  });

  it('ignores optional and non-blocking requirements', () => {
    const out = computeActivation({
      applicationStatus: 'pending',
      requirements: [
        req('a', 'approved'),
        req('optional', 'not_started', { required: false, blocking: false }),
      ],
      driver: null,
      now: NOW,
    });
    expect(out.decision).toBe('eligible');
  });

  it('is pending_review when the only open items are in review', () => {
    const out = computeActivation({
      applicationStatus: 'pending',
      requirements: [req('a', 'approved'), req('b', 'under_review')],
      driver: null,
      now: NOW,
    });
    expect(out.decision).toBe('pending_review');
    expect(out.reasonCodes).toEqual(['in_review:b']);
  });

  it('is ineligible with required actions when steps are missing', () => {
    const out = computeActivation({
      applicationStatus: 'in_progress',
      requirements: [req('a', 'not_started'), req('b', 'rejected')],
      driver: null,
      now: NOW,
    });
    expect(out.decision).toBe('ineligible');
    expect(out.requiredActions).toEqual(['a', 'b']);
  });

  it('flags expired requirements even after activation', () => {
    const out = computeActivation({
      applicationStatus: 'approved',
      requirements: [req('license', 'approved', { expires_at: '2026-07-01T00:00:00Z' })],
      driver: { is_verified: true, is_active: true },
      now: NOW,
    });
    expect(out.decision).toBe('expired_requirement');
    expect(out.reasonCodes).toEqual(['expired:license']);
  });

  it('suspension wins over everything', () => {
    const out = computeActivation({
      applicationStatus: 'approved',
      requirements: [req('a', 'approved')],
      driver: { is_verified: true, is_active: false },
      now: NOW,
    });
    expect(out.decision).toBe('suspended');
  });

  it('rejected application is ineligible', () => {
    const out = computeActivation({
      applicationStatus: 'rejected',
      requirements: [],
      driver: null,
      now: NOW,
    });
    expect(out.decision).toBe('ineligible');
    expect(out.reasonCodes).toEqual(['application_rejected']);
  });
});

describe('backgroundRequirementStatus', () => {
  it('maps provider lifecycle onto requirement states', () => {
    expect(backgroundRequirementStatus(null)).toBe('not_started');
    expect(backgroundRequirementStatus({ status: 'candidate_action', provider: 'checkr', expires_at: null })).toBe('needs_action');
    expect(backgroundRequirementStatus({ status: 'provider_pending', provider: 'checkr', expires_at: null })).toBe('under_review');
    expect(backgroundRequirementStatus({ status: 'clear', provider: 'checkr', expires_at: null })).toBe('approved');
    expect(backgroundRequirementStatus({ status: 'consider', provider: 'checkr', expires_at: null })).toBe('under_review');
    expect(backgroundRequirementStatus({ status: 'adverse_final', provider: 'checkr', expires_at: null })).toBe('rejected');
    expect(backgroundRequirementStatus({ status: 'recheck_required', provider: 'manual', expires_at: null })).toBe('expired');
  });
});

describe('nextAction', () => {
  const defs = new Map([
    ['profile', def({ key: 'profile', sort_order: 10 })],
    ['license', def({ key: 'license', sort_order: 30 })],
    ['photo', def({ key: 'photo', sort_order: 40 })],
  ]);
  it('prioritizes problems over fresh steps', () => {
    const rows = [req('profile', 'not_started'), req('license', 'rejected'), req('photo', 'not_started')];
    const display = new Map<string, RequirementStatus>(rows.map((r) => [r.requirement_key, r.status]));
    expect(nextAction(rows, defs, display)).toBe('license');
  });
  it('falls back to the first unstarted step in order', () => {
    const rows = [req('profile', 'approved'), req('license', 'not_started'), req('photo', 'not_started')];
    const display = new Map<string, RequirementStatus>(rows.map((r) => [r.requirement_key, r.status]));
    expect(nextAction(rows, defs, display)).toBe('license');
  });
  it('returns null when everything is done or in review', () => {
    const rows = [req('profile', 'approved'), req('license', 'under_review')];
    const display = new Map<string, RequirementStatus>(rows.map((r) => [r.requirement_key, r.status]));
    expect(nextAction(rows, defs, display)).toBeNull();
  });
});

describe('EV eligibility', () => {
  const policy = {
    require_battery_electric: true,
    min_model_year: 2017,
    min_doors: 4,
    min_seatbelts: 4,
    max_vehicle_age_years: 10,
  };
  const tesla = {
    vin: '5YJ3E1EA8KF317000',
    make: 'TESLA',
    model: 'Model 3',
    year: 2022,
    doors: 4,
    seatbelts: 5,
    powertrain: 'bev',
    bodyType: 'Sedan',
  };

  it('accepts a modern BEV', () => {
    const out = checkEvEligibility(tesla, policy, NOW);
    expect(out.eligible).toBe(true);
  });

  it('rejects hybrids and combustion vehicles outright', () => {
    for (const powertrain of ['hev', 'phev', 'ice']) {
      const out = checkEvEligibility({ ...tesla, powertrain }, policy, NOW);
      expect(out.eligible).toBe(false);
      expect(out.reasons).toContain('not_battery_electric');
      expect(out.needsReview).toBe(false);
    }
  });

  it('requires manual review when powertrain is unverifiable', () => {
    const out = checkEvEligibility({ ...tesla, powertrain: 'unknown' }, policy, NOW);
    expect(out.eligible).toBe(false);
    expect(out.needsReview).toBe(true);
  });

  it('enforces market min model year and max age', () => {
    expect(checkEvEligibility({ ...tesla, year: 2016 }, policy, NOW).reasons).toContain('below_min_model_year');
    expect(
      checkEvEligibility({ ...tesla, year: 2014 }, { ...policy, min_model_year: 2010 }, NOW).reasons,
    ).toContain('exceeds_max_vehicle_age');
  });

  it('enforces doors and seatbelts', () => {
    expect(checkEvEligibility({ ...tesla, doors: 2 }, policy, NOW).reasons).toContain('too_few_doors');
    expect(checkEvEligibility({ ...tesla, seatbelts: 2 }, policy, NOW).reasons).toContain('too_few_seatbelts');
  });

  it('policy is configurable — a market without an age cap accepts older EVs', () => {
    const out = checkEvEligibility({ ...tesla, year: 2018 }, { require_battery_electric: true }, NOW);
    expect(out.eligible).toBe(true);
  });
});

describe('powertrain normalization', () => {
  it('maps vPIC fields', () => {
    expect(normalizePowertrain({ ElectrificationLevel: 'BEV (Battery Electric Vehicle)' })).toBe('bev');
    expect(normalizePowertrain({ ElectrificationLevel: 'PHEV (Plug-in Hybrid Electric Vehicle)' })).toBe('phev');
    expect(normalizePowertrain({ FuelTypePrimary: 'Electric' })).toBe('bev');
    expect(normalizePowertrain({ FuelTypePrimary: 'Gasoline', FuelTypeSecondary: 'Electric' })).toBe('phev');
    expect(normalizePowertrain({ FuelTypePrimary: 'Gasoline' })).toBe('ice');
    expect(normalizePowertrain({})).toBe('unknown');
  });
});

describe('identifier normalization', () => {
  it('accepts valid VINs and rejects I/O/Q and wrong lengths', () => {
    expect(normalizeVin(' 5yj3e1ea8kf317000 ')).toBe('5YJ3E1EA8KF317000');
    expect(normalizeVin('5YJ3E1EA8KF31700O')).toBeNull();
    expect(normalizeVin('SHORT')).toBeNull();
  });
  it('normalizes plates per jurisdiction input quirks', () => {
    expect(normalizePlate(' abc-1234 ')).toBe('ABC1234');
    expect(normalizePlate('abc 1234')).toBe('ABC1234');
  });
});
