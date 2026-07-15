import { getClerkInstance } from '@clerk/clerk-expo';
import { tokenCache } from '@clerk/clerk-expo/token-cache';

export const CLERK_PUBLISHABLE_KEY =
  process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ?? '';

/**
 * The Clerk singleton outside React. <ClerkProvider> drives the same
 * instance; passing the key and token cache here too means the session can
 * still be restored if a non-React code path (Supabase's accessToken hook,
 * the background location task) runs first.
 */
function getClerk() {
  return getClerkInstance({
    publishableKey: CLERK_PUBLISHABLE_KEY,
    tokenCache,
  });
}

/**
 * Current Clerk session JWT, or null when signed out. getToken()
 * transparently refreshes the short-lived token. Headless launches (the
 * background location task fires before <ClerkProvider> mounts) need an
 * explicit load() to restore the persisted session; clerk-js no-ops the
 * provider's later load, so doing it here is safe.
 */
export async function getClerkToken(): Promise<string | null> {
  const clerk = getClerk();
  if (!clerk.loaded) {
    try {
      await clerk.load();
    } catch {
      return null;
    }
  }
  return (await clerk.session?.getToken()) ?? null;
}
