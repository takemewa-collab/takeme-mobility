import { useCallback, useMemo } from 'react';
import { useRouter } from 'expo-router';
import { useOnboarding } from '@/providers/onboarding';
import {
  deriveApplicationSteps,
  stepForRequirementKey,
  type ApplicationSteps,
  type ApplicationStep,
} from '@/lib/application-steps';

interface StepFlow {
  derived: ApplicationSteps | null;
  /** The display step owning `requirementKey`, when one was given and found. */
  step: ApplicationStep | null;
  /** 1-based position for "Step 3 of 8"; null when unknown. */
  stepNumber: number | null;
  totalSteps: number;
  /**
   * Replace this screen with the next thing the application needs: the next
   * open step, or the Final review screen when nothing is actionable. Reads
   * the state current at the last render — call it only after a mutation's
   * state adoption has re-rendered (SubmitSuccess / result views do).
   */
  goNext: () => void;
}

export function useStepFlow(requirementKey?: string): StepFlow {
  const router = useRouter();
  const { state } = useOnboarding();

  const derived = useMemo(() => (state ? deriveApplicationSteps(state) : null), [state]);

  const position = useMemo(() => {
    if (!derived || !requirementKey) return null;
    return stepForRequirementKey(derived, requirementKey);
  }, [derived, requirementKey]);

  const goNext = useCallback(() => {
    if (!derived) {
      router.replace('/onboarding');
      return;
    }
    const next = derived.nextStep;
    if (next?.href) {
      router.replace(next.href);
    } else {
      router.replace('/onboarding/review');
    }
  }, [derived, router]);

  return {
    derived,
    step: position?.step ?? null,
    stepNumber: position ? position.index + 1 : null,
    totalSteps: derived?.totalCount ?? 0,
    goNext,
  };
}
