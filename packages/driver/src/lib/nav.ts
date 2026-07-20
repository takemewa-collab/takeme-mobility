import type { Router } from 'expo-router';

/**
 * Leave a task screen safely: pop back when a real history entry exists
 * (normal push from the Activation Center), otherwise land on the Activation
 * Center — the correct parent for deep-linked task pages with no history.
 * Never replaces over a valid stack, so iOS swipe-back and Android system
 * back stay coherent.
 */
export function exitTask(router: Router): void {
  if (router.canGoBack()) {
    router.back();
  } else {
    router.replace('/onboarding');
  }
}
