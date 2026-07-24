import * as WebBrowser from 'expo-web-browser';
import { API, ApiClient, ApiError } from '@takeme/shared';

/**
 * Stripe Connect payout-setup flow.
 *
 * Contract (client side):
 *  - Account Links are SINGLE-USE and expire: every tap mints a fresh link
 *    via POST /api/driver/payouts/account-link and uses THAT response's URL.
 *    URLs are never cached, stored, or logged.
 *  - The link opens in an authenticated browser session that returns to the
 *    app via the takeme-driver://payouts/return deep link (the platform's
 *    HTTPS bridge pages redirect there).
 *  - Stripe sends an expired/stale link to the refresh bridge — when the
 *    session ends on payouts/refresh we immediately mint a fresh link and
 *    reopen so the driver never dead-ends on "link expired".
 *  - Callers must re-fetch GET /api/driver/payouts after this resolves,
 *    whatever the outcome — onboarding state may have changed server-side.
 */

export type AccountLinkErrorCode =
  | 'connect_not_enabled'
  | 'account_create_failed'
  | 'account_link_failed'
  | 'network'
  | 'unknown';

export interface AccountLinkError {
  code: AccountLinkErrorCode;
  message: string;
}

export type PayoutSetupOutcome = { ok: true } | { ok: false; error: AccountLinkError };

const RETURN_URL = 'takeme-driver://payouts/return';
/** Safety bound on the refresh→fresh-link loop; each pass is a full browser round-trip. */
const MAX_LINK_ROUNDS = 5;

/** Map a failed account-link request to driver-facing copy (server's words first). */
export function accountLinkError(err: unknown): AccountLinkError {
  if (err instanceof ApiError) {
    const body =
      err.body && typeof err.body === 'object'
        ? (err.body as { error?: unknown; code?: unknown })
        : null;
    const message =
      typeof body?.error === 'string' && body.error
        ? body.error
        : 'Payout setup is unavailable right now. Please try again later.';
    const code = typeof body?.code === 'string' ? body.code : '';
    if (
      code === 'connect_not_enabled' ||
      code === 'account_create_failed' ||
      code === 'account_link_failed'
    ) {
      return { code, message };
    }
    return { code: 'unknown', message };
  }
  return { code: 'network', message: "Couldn't reach TAKEME. Check your connection." };
}

/**
 * Mint a fresh account link and walk the driver through the Stripe-hosted
 * surface. Resolves once the browser session is over (or link creation
 * failed). Diagnostics log steps only — never URLs or tokens.
 */
export async function runPayoutSetup(
  apiClient: ApiClient,
  mode: 'onboard' | 'manage',
): Promise<PayoutSetupOutcome> {
  for (let round = 0; round < MAX_LINK_ROUNDS; round++) {
    console.log(`[payout-setup] link=requested mode=${mode} round=${round}`);
    let url: string;
    try {
      const res = await apiClient.post<{ url?: unknown }>(API.DRIVER_PAYOUTS_ACCOUNT_LINK, {
        mode,
      });
      if (typeof res?.url !== 'string' || !res.url) {
        console.log('[payout-setup] link=missing_url');
        return {
          ok: false,
          error: { code: 'unknown', message: 'Payout setup is unavailable right now.' },
        };
      }
      url = res.url;
    } catch (err) {
      const error = accountLinkError(err);
      console.log(`[payout-setup] link=failed code=${error.code}`);
      return { ok: false, error };
    }

    console.log('[payout-setup] browser=opened');
    const result = await WebBrowser.openAuthSessionAsync(url, RETURN_URL);
    console.log(`[payout-setup] browser=closed type=${result.type}`);

    // Stripe routed to the refresh bridge: the link went stale mid-flow.
    // Mint a fresh one and drop the driver straight back in.
    if (
      result.type === 'success' &&
      typeof result.url === 'string' &&
      result.url.includes('payouts/refresh')
    ) {
      console.log('[payout-setup] link=stale, requesting fresh link');
      continue;
    }

    return { ok: true };
  }
  return { ok: true };
}
