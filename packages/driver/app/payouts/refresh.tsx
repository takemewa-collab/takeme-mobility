import { Redirect } from 'expo-router';

/**
 * Deep-link landing for the Stripe payout-setup REFRESH bridge (stale/used
 * account link). Inside the auth session the setup flow intercepts this URL
 * and mints a fresh link automatically; this route is the plain-browser
 * fallback. Earnings re-fetches payout state on focus, and the driver can
 * re-open Cash Out to continue setup with a fresh link.
 */
export default function PayoutRefresh() {
  return <Redirect href="/(app)/(tabs)/earnings" />;
}
