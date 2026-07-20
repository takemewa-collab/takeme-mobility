import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { decideDestination, mustForceOffline } from '../activation-route';
import type { OnboardingState } from '../../types/onboarding';

type GateState = Pick<OnboardingState, 'activation' | 'driver'>;

function state(
  decision: OnboardingState['activation']['decision'],
  driver: Partial<OnboardingState['driver']> = {},
): GateState {
  return {
    activation: { decision, reasonCodes: [], requiredActions: [], nextAction: null },
    driver: { exists: true, isVerified: true, isActive: true, ...driver },
  };
}

describe('decideDestination — server-authoritative routing', () => {
  it('fresh phone number (no state yet / fetch failed) fails closed', () => {
    expect(decideDestination(null)).toBe('blocked');
  });

  it('new applicant with no requirements done goes to onboarding', () => {
    expect(decideDestination(state('ineligible', { exists: false, isVerified: false, isActive: false }))).toBe('onboarding');
  });

  it('returning incomplete applicant resumes onboarding', () => {
    expect(decideDestination(state('ineligible', { exists: false }))).toBe('onboarding');
  });

  it('applicant under review stays on the status surface, not the dashboard', () => {
    expect(decideDestination(state('pending_review', { exists: false, isVerified: false }))).toBe('onboarding');
  });

  it('eligible and provisioned driver reaches the dashboard', () => {
    expect(decideDestination(state('eligible'))).toBe('dashboard');
  });

  it('eligible decision without a provisioned driver row is NOT dashboard', () => {
    expect(decideDestination(state('eligible', { exists: false, isVerified: false, isActive: false }))).toBe('onboarding');
  });

  it('an unverified or deactivated driver row never reaches the dashboard', () => {
    expect(decideDestination(state('eligible', { isVerified: false }))).toBe('onboarding');
    expect(decideDestination(state('eligible', { isActive: false }))).toBe('onboarding');
  });

  it('suspended / expired / blocked drivers are kept out of the dashboard', () => {
    for (const decision of ['suspended', 'expired_requirement', 'temporarily_blocked'] as const) {
      expect(decideDestination(state(decision))).toBe('onboarding');
    }
  });
});

describe('mustForceOffline', () => {
  it('forces offline for suspension, expiry, and blocks', () => {
    expect(mustForceOffline(state('suspended'))).toBe(true);
    expect(mustForceOffline(state('expired_requirement'))).toBe(true);
    expect(mustForceOffline(state('temporarily_blocked'))).toBe(true);
  });
  it('leaves eligible and in-review drivers alone', () => {
    expect(mustForceOffline(state('eligible'))).toBe(false);
    expect(mustForceOffline(state('pending_review'))).toBe(false);
    expect(mustForceOffline(null)).toBe(false);
  });
});

describe('production navigation hygiene', () => {
  const appDir = join(__dirname, '..', '..', '..', 'app');
  // Emoji & pictograph blocks; excludes basic punctuation/arrows used in text.
  const emoji = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{263A}\u{2B50}]/u;

  function collect(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return collect(full);
      return /\.(ts|tsx)$/.test(name) ? [full] : [];
    });
  }

  it('no emoji anywhere in production screens', () => {
    const offenders = collect(appDir).filter((file) => emoji.test(readFileSync(file, 'utf8')));
    expect(offenders.map((f) => f.replace(appDir, 'app'))).toEqual([]);
  });

  it('no competitor branding in production screens', () => {
    const brands = /\b(lyft|uber)\b/i;
    const offenders = collect(appDir).filter((file) => brands.test(readFileSync(file, 'utf8')));
    expect(offenders.map((f) => f.replace(appDir, 'app'))).toEqual([]);
  });
});
