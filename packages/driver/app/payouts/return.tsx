import { Redirect } from 'expo-router';

/**
 * Deep-link landing for the Stripe payout-setup RETURN bridge
 * (https://www.takememobility.com/driver/payout-setup/return →
 * takeme-driver://payouts/return). The in-app auth session normally consumes
 * this URL itself; this route exists for the plain-browser fallback so the
 * link never dead-ends. Landing on Earnings re-fetches payout state on focus.
 */
export default function PayoutReturn() {
  return <Redirect href="/(app)/(tabs)/earnings" />;
}
