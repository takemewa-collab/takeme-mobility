import { describe, expect, it } from 'vitest';
import {
  combineStatuses,
  deriveApplicationSteps,
  stepForRequirementKey,
  STEP_STATUS_LABEL,
} from '../application-steps';
import type {
  OnboardingRequirement,
  OnboardingState,
  RequirementStatus,
} from '@/types/onboarding';

function req(
  key: string,
  status: RequirementStatus,
  overrides: Partial<OnboardingRequirement> = {},
): OnboardingRequirement {
  const categories: Record<string, OnboardingRequirement['category']> = {
    profile_details: 'identity',
    legal_agreements: 'legal',
    drivers_license: 'identity',
    profile_photo: 'identity',
    vehicle_details: 'vehicle',
    vehicle_registration: 'vehicle',
    vehicle_insurance: 'vehicle',
    background_check: 'background',
    safety_training: 'training',
    wa_for_hire_permit: 'market_permit',
    payout_setup: 'opportunity',
    seatac_airport_permit: 'opportunity',
  };
  const docKinds: Record<string, string[]> = {
    drivers_license: ['license_front', 'license_back'],
    profile_photo: ['profile_photo'],
    vehicle_registration: ['registration'],
    vehicle_insurance: ['insurance'],
    wa_for_hire_permit: ['for_hire_permit'],
    seatac_airport_permit: ['airport_permit'],
  };
  const sortOrders: Record<string, number> = {
    profile_details: 10,
    legal_agreements: 20,
    drivers_license: 30,
    profile_photo: 40,
    vehicle_details: 50,
    vehicle_registration: 60,
    vehicle_insurance: 70,
    background_check: 80,
    safety_training: 90,
    wa_for_hire_permit: 100,
    payout_setup: 200,
    seatac_airport_permit: 210,
  };
  return {
    key,
    title: key,
    summary: `${key} summary`,
    instructions: null,
    category: categories[key] ?? 'market_permit',
    reviewMethod: 'auto',
    required: !['payout_setup', 'seatac_airport_permit'].includes(key),
    blocking: !['payout_setup', 'seatac_airport_permit'].includes(key),
    externalUrl: null,
    docKinds: docKinds[key] ?? null,
    dependsOn: null,
    sortOrder: sortOrders[key] ?? 500,
    status,
    rejectionReason: null,
    reviewNote: null,
    expiresAt: null,
    updatedAt: null,
    config: {},
    documents: [],
    ...overrides,
  };
}

/** The full Seattle individual-owner requirement set. */
function seattleRequirements(
  statuses: Partial<Record<string, RequirementStatus>> = {},
): OnboardingRequirement[] {
  const keys = [
    'profile_details',
    'legal_agreements',
    'drivers_license',
    'profile_photo',
    'vehicle_details',
    'vehicle_registration',
    'vehicle_insurance',
    'background_check',
    'safety_training',
    'wa_for_hire_permit',
    'payout_setup',
    'seatac_airport_permit',
  ];
  return keys.map((k) => req(k, statuses[k] ?? 'not_started'));
}

function state(requirements: OnboardingRequirement[]): OnboardingState {
  return {
    application: null,
    market: {
      id: 'm1',
      key: 'seattle_wa_us',
      displayName: 'Seattle, Washington',
      status: 'active',
      evPolicy: {},
    },
    requirements,
    backgroundCheck: null,
    consents: [],
    activation: { decision: 'ineligible', reasonCodes: [], requiredActions: [], nextAction: null },
    driver: { exists: false, isVerified: false, isActive: false },
  };
}

describe('combineStatuses', () => {
  it('maps the full requirement vocabulary onto the six dashboard statuses', () => {
    expect(combineStatuses(['not_started'])).toBe('not_started');
    expect(combineStatuses(['blocked'])).toBe('not_started');
    expect(combineStatuses(['in_progress'])).toBe('in_progress');
    expect(combineStatuses(['submitted'])).toBe('submitted');
    expect(combineStatuses(['under_review'])).toBe('under_review');
    expect(combineStatuses(['needs_action'])).toBe('action_needed');
    expect(combineStatuses(['rejected'])).toBe('action_needed');
    expect(combineStatuses(['expired'])).toBe('action_needed');
    expect(combineStatuses(['expiring_soon'])).toBe('action_needed');
    expect(combineStatuses(['approved'])).toBe('approved');
    expect(combineStatuses(['waived'])).toBe('approved');
  });

  it('a fix anywhere in the group dominates', () => {
    expect(combineStatuses(['approved', 'rejected', 'submitted'])).toBe('action_needed');
  });

  it('partially done groups are in progress, fully waiting groups are in review', () => {
    expect(combineStatuses(['approved', 'not_started'])).toBe('in_progress');
    expect(combineStatuses(['approved', 'submitted'])).toBe('submitted');
    expect(combineStatuses(['approved', 'under_review', 'submitted'])).toBe('under_review');
    expect(combineStatuses(['approved', 'approved'])).toBe('approved');
  });

  it('every step status has a display label', () => {
    (
      ['not_started', 'in_progress', 'submitted', 'under_review', 'action_needed', 'approved'] as const
    ).forEach((s) => expect(STEP_STATUS_LABEL[s]).toBeTruthy());
  });
});

describe('deriveApplicationSteps', () => {
  it('groups the Seattle individual-owner set into exactly 8 steps in order', () => {
    const derived = deriveApplicationSteps(state(seattleRequirements()));
    expect(derived.steps.map((s) => s.key)).toEqual([
      'personal_info',
      'agreements',
      'drivers_license',
      'profile_photo',
      'vehicle',
      'insurance',
      'background_check',
      'market_requirements',
    ]);
    expect(derived.totalCount).toBe(8);
    expect(derived.steps.map((s) => s.title)).toContain('Seattle requirements');
  });

  it('excludes optional requirements from steps and surfaces them separately', () => {
    const derived = deriveApplicationSteps(state(seattleRequirements()));
    const optionalKeys = derived.optional.map((r) => r.key);
    expect(optionalKeys).toEqual(['payout_setup', 'seatac_airport_permit']);
    const stepReqKeys = derived.steps.flatMap((s) => s.requirements.map((r) => r.key));
    expect(stepReqKeys).not.toContain('payout_setup');
  });

  it('counts completed steps, not raw requirements', () => {
    const derived = deriveApplicationSteps(
      state(
        seattleRequirements({
          profile_details: 'approved',
          legal_agreements: 'approved',
          vehicle_details: 'approved', // registration still open → step incomplete
        }),
      ),
    );
    expect(derived.completedCount).toBe(2);
    expect(derived.totalCount).toBe(8);
  });

  it('vehicle details + registration collapse into one step that continues to the open item', () => {
    const derived = deriveApplicationSteps(
      state(seattleRequirements({ vehicle_details: 'approved' })),
    );
    const vehicle = derived.steps.find((s) => s.key === 'vehicle')!;
    expect(vehicle.requirements.map((r) => r.key)).toEqual([
      'vehicle_details',
      'vehicle_registration',
    ]);
    expect(vehicle.status).toBe('in_progress');
    // Continue goes to the registration upload, not back to the VIN form.
    expect(vehicle.href).toEqual({
      pathname: '/onboarding/document',
      params: { key: 'vehicle_registration' },
    });
  });

  it('safety training and the for-hire permit fold into the market step', () => {
    const derived = deriveApplicationSteps(state(seattleRequirements()));
    const market = derived.steps.find((s) => s.key === 'market_requirements')!;
    expect(market.requirements.map((r) => r.key)).toEqual([
      'safety_training',
      'wa_for_hire_permit',
    ]);
  });

  it('next step is the first open step in display order', () => {
    const derived = deriveApplicationSteps(
      state(seattleRequirements({ profile_details: 'approved', legal_agreements: 'approved' })),
    );
    expect(derived.nextStep?.key).toBe('drivers_license');
  });

  it('a step needing fixes wins over earlier not-started steps', () => {
    const derived = deriveApplicationSteps(
      state(seattleRequirements({ vehicle_insurance: 'rejected' })),
    );
    expect(derived.nextStep?.key).toBe('insurance');
    expect(derived.nextStep?.status).toBe('action_needed');
  });

  it('blocked steps are shown as not started and never chosen as next', () => {
    const derived = deriveApplicationSteps(
      state(seattleRequirements({ profile_photo: 'blocked' })),
    );
    const photo = derived.steps.find((s) => s.key === 'profile_photo')!;
    expect(photo.status).toBe('not_started');
    expect(photo.blocked).toBe(true);
    expect(derived.nextStep?.key).toBe('personal_info');
  });

  it('when everything is approved or waiting, nextStep is null and review reflects it', () => {
    const derived = deriveApplicationSteps(
      state(
        seattleRequirements({
          profile_details: 'approved',
          legal_agreements: 'approved',
          drivers_license: 'under_review',
          profile_photo: 'submitted',
          vehicle_details: 'approved',
          vehicle_registration: 'submitted',
          vehicle_insurance: 'submitted',
          background_check: 'under_review',
          safety_training: 'approved',
          wa_for_hire_permit: 'submitted',
        }),
      ),
    );
    expect(derived.nextStep).toBeNull();
    expect(derived.reviewStep.status).toBe('under_review');
  });

  it('fully approved application marks final review approved', () => {
    const all: Partial<Record<string, RequirementStatus>> = {};
    for (const k of [
      'profile_details',
      'legal_agreements',
      'drivers_license',
      'profile_photo',
      'vehicle_details',
      'vehicle_registration',
      'vehicle_insurance',
      'background_check',
      'safety_training',
      'wa_for_hire_permit',
    ]) {
      all[k] = 'approved';
    }
    const derived = deriveApplicationSteps(state(seattleRequirements(all)));
    expect(derived.completedCount).toBe(8);
    expect(derived.reviewStep.status).toBe('approved');
  });

  it('surfaces rejection reasons as the step detail', () => {
    const reqs = seattleRequirements();
    const license = reqs.find((r) => r.key === 'drivers_license')!;
    license.status = 'rejected';
    license.rejectionReason = 'The photo was blurry.';
    const derived = deriveApplicationSteps(state(reqs));
    const step = derived.steps.find((s) => s.key === 'drivers_license')!;
    expect(step.detail).toBe('The photo was blurry.');
  });

  it('an unknown future requirement appears as its own trailing step (fail-safe)', () => {
    const reqs = [
      ...seattleRequirements(),
      req('mystery_new_requirement', 'not_started', { category: 'identity', sortOrder: 300 }),
    ];
    const derived = deriveApplicationSteps(state(reqs));
    expect(derived.totalCount).toBe(9);
    expect(derived.steps[8].title).toBe('mystery_new_requirement');
  });

  it('stepForRequirementKey finds the owning step and its position', () => {
    const derived = deriveApplicationSteps(state(seattleRequirements()));
    const hit = stepForRequirementKey(derived, 'vehicle_registration');
    expect(hit?.step.key).toBe('vehicle');
    expect(hit?.index).toBe(4);
  });

  it('rental path replaces the vehicle group and drops insurance', () => {
    const reqs = [
      req('profile_details', 'not_started'),
      req('legal_agreements', 'not_started'),
      req('drivers_license', 'not_started'),
      req('profile_photo', 'not_started'),
      req('rental_assignment', 'not_started', {
        category: 'vehicle',
        sortOrder: 50,
        summary: "We'll match you with an electric vehicle from the TAKEME fleet.",
      }),
      req('background_check', 'not_started'),
      req('safety_training', 'not_started'),
    ];
    const derived = deriveApplicationSteps(state(reqs));
    // personal, agreements, license, photo, vehicle, background, market(training)
    expect(derived.totalCount).toBe(7);
    const vehicle = derived.steps.find((s) => s.key === 'vehicle')!;
    expect(vehicle.explanation).toBe(
      "We'll match you with an electric vehicle from the TAKEME fleet.",
    );
    expect(derived.steps.some((s) => s.key === 'insurance')).toBe(false);
  });
});
