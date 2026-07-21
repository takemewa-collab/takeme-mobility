import type { Href } from 'expo-router';
import type {
  OnboardingRequirement,
  OnboardingState,
  RequirementStatus,
} from '@/types/onboarding';
// Relative import on purpose: this module is covered by vitest at the repo
// root, which resolves relative paths but not the app's `@/` alias.
import { hrefForRequirement } from './onboarding-routes';

/**
 * The application dashboard's step model.
 *
 * The server stays the single source of truth: every requirement, status, and
 * dependency comes from the onboarding API untouched. This module only GROUPS
 * those requirements into the fixed, human-sized steps the dashboard shows —
 * "Vehicle information" is one step to a driver even when the server tracks
 * vehicle details and registration separately. Nothing here mutates or
 * re-derives eligibility; it is presentation logic with tests.
 */

export type StepKey =
  | 'personal_info'
  | 'agreements'
  | 'drivers_license'
  | 'profile_photo'
  | 'vehicle'
  | 'insurance'
  | 'background_check'
  | 'market_requirements'
  | 'final_review';

/** The six statuses the dashboard vocabulary allows, plus nothing else. */
export type StepStatus =
  | 'not_started'
  | 'in_progress'
  | 'submitted'
  | 'under_review'
  | 'action_needed'
  | 'approved';

export interface ApplicationStep {
  key: StepKey;
  title: string;
  /** One short line for the next-step card. */
  explanation: string;
  /** e.g. "About 2 min". */
  estimatedTime: string;
  status: StepStatus;
  /** Every prerequisite is unmet — the step can't be worked on yet. */
  blocked: boolean;
  /** Rejection reason / renewal note surfaced from the underlying requirement. */
  detail: string | null;
  /** How long review usually takes; shown while submitted / under review. */
  reviewEstimate: string | null;
  /** Where "Continue" goes: the first requirement that still needs the driver. */
  href: Href | null;
  requirements: OnboardingRequirement[];
}

export interface ApplicationSteps {
  steps: ApplicationStep[];
  /** Non-required extras (payout, airport permit, local tips) — never counted. */
  optional: OnboardingRequirement[];
  completedCount: number;
  totalCount: number;
  /**
   * The single step the driver should work on now: fixes first, then the
   * first open step in order. Null when nothing needs the driver (all
   * approved or waiting on review) — the dashboard offers Final review then.
   */
  nextStep: ApplicationStep | null;
  /** The virtual Final review step, always last in the display list. */
  reviewStep: ApplicationStep;
}

const DONE: RequirementStatus[] = ['approved', 'waived', 'not_applicable'];
const WAITING: RequirementStatus[] = ['submitted', 'under_review'];
const NEEDS_FIX: RequirementStatus[] = ['needs_action', 'rejected', 'expired', 'expiring_soon'];

interface StepDef {
  key: Exclude<StepKey, 'final_review'>;
  title: string;
  explanation: string;
  estimatedTime: string;
  reviewEstimate: string | null;
  /** Explicit requirement keys owned by this step (highest precedence). */
  keys: string[];
  /** Category fallback for requirements not claimed by an explicit key. */
  categories: string[];
}

const STEP_DEFS: StepDef[] = [
  {
    key: 'personal_info',
    title: 'Personal information',
    explanation: 'Your legal name and contact details, as they appear on your license.',
    estimatedTime: 'About 2 min',
    reviewEstimate: null,
    keys: ['profile_details'],
    categories: [],
  },
  {
    key: 'agreements',
    title: 'Driver agreements',
    explanation: 'Review and accept the TAKEME driver agreements.',
    estimatedTime: 'About 5 min',
    reviewEstimate: null,
    keys: ['legal_agreements', 'subcarrier_agreement_step'],
    categories: ['legal'],
  },
  {
    key: 'drivers_license',
    title: "Driver's license",
    explanation: 'Photograph the front and back of your license.',
    estimatedTime: 'About 2 min',
    reviewEstimate: 'Usually reviewed within 24 hours.',
    keys: ['drivers_license'],
    categories: [],
  },
  {
    key: 'profile_photo',
    title: 'Profile photo',
    explanation: 'A clear, front-facing photo so riders can recognize you.',
    estimatedTime: 'About 1 min',
    reviewEstimate: 'Usually reviewed within 24 hours.',
    keys: ['profile_photo'],
    categories: [],
  },
  {
    key: 'vehicle',
    title: 'Vehicle information',
    explanation: 'Your electric vehicle and its registration.',
    estimatedTime: 'About 3 min',
    reviewEstimate: 'Usually reviewed within 1–2 business days.',
    keys: ['vehicle_details', 'vehicle_registration', 'rental_assignment', 'fleet_membership', 'fleet_owner_setup'],
    categories: ['vehicle'],
  },
  {
    key: 'insurance',
    title: 'Insurance',
    explanation: 'Proof of insurance that lists you as a covered driver.',
    estimatedTime: 'About 1 min',
    reviewEstimate: 'Usually reviewed within 24 hours.',
    keys: ['vehicle_insurance', 'commercial_liability_insurance'],
    categories: [],
  },
  {
    key: 'background_check',
    title: 'Background check',
    explanation: 'Authorize a standard driving-record and background screening.',
    estimatedTime: 'About 5 min',
    reviewEstimate: 'Usually completed in 3–5 business days.',
    keys: ['background_check'],
    categories: ['background'],
  },
  {
    key: 'market_requirements',
    title: 'Local requirements',
    explanation: 'Local permits and a short safety course for your market.',
    estimatedTime: 'About 10 min',
    reviewEstimate: 'Usually reviewed within 1–2 business days.',
    keys: ['wa_for_hire_permit', 'wa_chauffeur_credential', 'wa_limousine_decal', 'wa_business_license', 'safety_training'],
    categories: ['market_permit', 'training'],
  },
];

export const STEP_STATUS_LABEL: Record<StepStatus, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  submitted: 'Submitted',
  under_review: 'Under review',
  action_needed: 'Action needed',
  approved: 'Approved',
};

/** Collapses a set of requirement statuses into one dashboard status. */
export function combineStatuses(statuses: RequirementStatus[]): StepStatus {
  const live = statuses.filter((s) => s !== 'not_applicable');
  if (live.length === 0) return 'approved';
  if (live.some((s) => NEEDS_FIX.includes(s))) return 'action_needed';
  if (live.every((s) => DONE.includes(s))) return 'approved';
  if (live.every((s) => DONE.includes(s) || WAITING.includes(s))) {
    return live.some((s) => s === 'under_review') ? 'under_review' : 'submitted';
  }
  if (live.some((s) => s === 'in_progress' || WAITING.includes(s) || DONE.includes(s))) {
    return 'in_progress';
  }
  return 'not_started';
}

function requirementDetail(req: OnboardingRequirement): string | null {
  if (req.status === 'rejected' || req.status === 'needs_action') {
    return req.rejectionReason ?? req.reviewNote;
  }
  if (req.status === 'expired') return 'This has expired and needs to be renewed.';
  if (req.status === 'expiring_soon' && req.expiresAt) {
    const date = new Date(req.expiresAt);
    if (!Number.isNaN(date.getTime())) {
      return `Renew by ${date.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}.`;
    }
  }
  return null;
}

/** The requirement "Continue" should open: fixes first, then first open item. */
function activeRequirement(reqs: OnboardingRequirement[]): OnboardingRequirement | null {
  const fix = reqs.find((r) => NEEDS_FIX.includes(r.status));
  if (fix) return fix;
  return reqs.find((r) => !DONE.includes(r.status) && !WAITING.includes(r.status)) ?? null;
}

function buildStep(def: StepDef, reqs: OnboardingRequirement[], marketCity: string | null): ApplicationStep | null {
  const members = reqs.sort((a, b) => a.sortOrder - b.sortOrder);
  if (members.length === 0) return null;

  const status = combineStatuses(members.map((r) => r.status));
  const open = members.filter((r) => !DONE.includes(r.status));
  const blocked = open.length > 0 && open.every((r) => r.status === 'blocked');
  const active = activeRequirement(members);
  const target = active ?? members[0];
  const detail = members.map(requirementDetail).find((d) => d != null) ?? null;

  // Vehicle step: a rental / fleet path reads better with the server's own
  // words ("We'll match you with a vehicle…") than the generic EV line.
  let explanation = def.explanation;
  if (def.key === 'vehicle' && members[0] && members[0].key !== 'vehicle_details') {
    explanation = members[0].summary || def.explanation;
  }

  const title =
    def.key === 'market_requirements' && marketCity ? `${marketCity} requirements` : def.title;

  return {
    key: def.key,
    title,
    explanation,
    estimatedTime: def.estimatedTime,
    status,
    blocked,
    detail,
    reviewEstimate: def.reviewEstimate,
    href: hrefForRequirement(target),
    requirements: members,
  };
}

function isOptional(req: OnboardingRequirement): boolean {
  return !req.required || req.category === 'opportunity';
}

export function deriveApplicationSteps(state: OnboardingState): ApplicationSteps {
  const relevant = (state.requirements ?? []).filter((r) => r.status !== 'not_applicable');
  const optional = relevant
    .filter(isOptional)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const core = relevant.filter((r) => !isOptional(r));

  // "Seattle, Washington" → "Seattle" for the market step's title.
  const marketCity = state.market?.displayName.split(',')[0]?.trim() || null;

  // A requirement named by ANY step's key list belongs to that step — category
  // fallbacks must never steal it (vehicle_insurance is category 'vehicle' but
  // is the Insurance step's, not the Vehicle step's).
  const explicitlyOwned = new Set(STEP_DEFS.flatMap((d) => d.keys));

  const claimed = new Set<string>();
  const steps: ApplicationStep[] = [];

  for (const def of STEP_DEFS) {
    const byKey = core.filter((r) => def.keys.includes(r.key));
    byKey.forEach((r) => claimed.add(r.key));
    const byCategory = core.filter(
      (r) =>
        !claimed.has(r.key) &&
        !explicitlyOwned.has(r.key) &&
        def.categories.includes(r.category),
    );
    byCategory.forEach((r) => claimed.add(r.key));
    const step = buildStep(def, [...byKey, ...byCategory], marketCity);
    if (step) steps.push(step);
  }

  // Fail-safe: a new server requirement we don't know about still shows up as
  // its own step at the end rather than silently disappearing.
  const orphans = core.filter((r) => !claimed.has(r.key)).sort((a, b) => a.sortOrder - b.sortOrder);
  for (const req of orphans) {
    steps.push({
      key: 'market_requirements',
      title: req.title,
      explanation: req.summary,
      estimatedTime: 'A few minutes',
      status: combineStatuses([req.status]),
      blocked: req.status === 'blocked',
      detail: requirementDetail(req),
      reviewEstimate: null,
      href: hrefForRequirement(req),
      requirements: [req],
    });
  }

  const completedCount = steps.filter((s) => s.status === 'approved').length;

  const fix = steps.find((s) => s.status === 'action_needed');
  const open = steps.find(
    (s) => (s.status === 'not_started' || s.status === 'in_progress') && !s.blocked,
  );
  const nextStep = fix ?? open ?? null;

  const allWaiting =
    steps.length > 0 && steps.every((s) => s.status === 'approved' || s.status === 'submitted' || s.status === 'under_review');
  const reviewStep: ApplicationStep = {
    key: 'final_review',
    title: 'Final review',
    explanation: 'See what’s complete and what we’re still reviewing.',
    estimatedTime: 'About 1 min',
    status:
      completedCount === steps.length && steps.length > 0
        ? 'approved'
        : allWaiting
          ? 'under_review'
          : 'not_started',
    blocked: false,
    detail: null,
    reviewEstimate: null,
    href: '/onboarding/review',
    requirements: [],
  };

  return { steps, optional, completedCount, totalCount: steps.length, nextStep, reviewStep };
}

/** Locates the display step that owns a server requirement key. */
export function stepForRequirementKey(
  derived: ApplicationSteps,
  requirementKey: string,
): { step: ApplicationStep; index: number } | null {
  const index = derived.steps.findIndex((s) =>
    s.requirements.some((r) => r.key === requirementKey),
  );
  if (index < 0) return null;
  return { step: derived.steps[index], index };
}

/** Locates a display step by its step key. */
export function stepByKey(
  derived: ApplicationSteps,
  key: StepKey,
): { step: ApplicationStep; index: number } | null {
  const index = derived.steps.findIndex((s) => s.key === key);
  if (index < 0) return null;
  return { step: derived.steps[index], index };
}
