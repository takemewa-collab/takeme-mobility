import type { Href } from 'expo-router';
import type { OnboardingRequirement } from '@/types/onboarding';

/**
 * Maps a server requirement to the screen that satisfies it. Requirements are
 * data-driven, so routing keys off category/shape rather than hardcoded keys.
 * Returns null when nothing in-app can advance it (e.g. external-only or
 * manual review) — callers fall back to the requirement's externalUrl.
 */
export function hrefForRequirement(req: OnboardingRequirement): Href | null {
  if (req.category === 'background') {
    return '/onboarding/background';
  }
  if (req.reviewMethod === 'quiz' || (req.config.questions?.length ?? 0) > 0) {
    return { pathname: '/onboarding/training', params: { key: req.key } };
  }
  if ((req.config.legal_keys?.length ?? 0) > 0) {
    return { pathname: '/onboarding/legal', params: { keys: req.config.legal_keys!.join(',') } };
  }
  if ((req.docKinds?.length ?? 0) > 0) {
    return { pathname: '/onboarding/document', params: { key: req.key } };
  }
  if (req.category === 'vehicle') {
    return '/onboarding/vehicle';
  }
  if (req.category === 'identity') {
    return '/onboarding/profile';
  }
  if (req.category === 'opportunity') {
    return '/onboarding/profile';
  }
  return null;
}
