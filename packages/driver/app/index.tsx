import { Redirect } from 'expo-router';

/**
 * `/` has no screen of its own. Send everyone toward the app group — its
 * layout bounces signed-out users to /(auth)/login, so this one redirect
 * covers both cold-start cases. Without it the launcher lands on an
 * unmatched route and the app appears frozen on the splash background.
 */
export default function Index() {
  return <Redirect href="/(app)/(tabs)/dashboard" />;
}
