import type { OnboardingState } from '@/types/onboarding';

/**
 * Server-authoritative routing decision for a signed-in driver.
 * Pure and fail-closed: anything short of a confirmed eligible driver keeps
 * the operational dashboard out of reach. A Clerk session alone proves
 * identity, never activation.
 */
export type GateDestination =
  | 'dashboard' // confirmed eligible, provisioned driver
  | 'onboarding' // everything else with a known state (new, resuming, in review, suspended)
  | 'blocked'; // no state available (still loading or fetch failed) — fail closed

export function decideDestination(
  state: Pick<OnboardingState, 'activation' | 'driver'> | null,
): GateDestination {
  if (!state) return 'blocked';
  const { activation, driver } = state;
  if (
    activation.decision === 'eligible' &&
    driver.exists &&
    driver.isVerified &&
    driver.isActive
  ) {
    return 'dashboard';
  }
  return 'onboarding';
}

/** Decisions that must force an online driver offline (outside an active trip). */
export function mustForceOffline(
  state: Pick<OnboardingState, 'activation'> | null,
): boolean {
  if (!state) return false;
  return ['suspended', 'expired_requirement', 'temporarily_blocked'].includes(
    state.activation.decision,
  );
}
