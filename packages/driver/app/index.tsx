import { Redirect } from 'expo-router';

/**
 * `/` has no screen of its own. Cold starts land on the Activation Center,
 * which is the single routing choke point: it redirects confirmed-eligible
 * drivers to the dashboard and keeps everyone else in onboarding. Its layout
 * bounces signed-out users to /(auth)/login. Routing to the dashboard from
 * here would trust a Clerk session as activation, which it is not.
 */
export default function Index() {
  return <Redirect href="/onboarding" />;
}
