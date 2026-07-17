// ═══════════════════════════════════════════════════════════════════════════
// Production safeguard: test fixtures must never become live supply.
//
// The E2E harness and any future seed tooling must set ALLOW_TEST_FIXTURES=1
// explicitly; that variable is never configured in the production Vercel
// environment, so fixture-shaped identities are rejected at every path that
// could create or activate a driver.
// ═══════════════════════════════════════════════════════════════════════════

const FICTIONAL_PHONE = /555\s?-?01\d{2}$/; // NANP reserved fictional range
const FIXTURE_NAME = /\b(test|demo|fake|fixture|e2e)\b/i;
const FIXTURE_PLATE = /^(e2e|test|demo)/i;

export function isTestFixtureIdentity(input: {
  fullName?: string | null;
  phone?: string | null;
  plateNumber?: string | null;
}): boolean {
  if (input.phone && FICTIONAL_PHONE.test(input.phone)) return true;
  if (input.fullName && FIXTURE_NAME.test(input.fullName)) return true;
  if (input.plateNumber && FIXTURE_PLATE.test(input.plateNumber)) return true;
  return false;
}

/**
 * Throws when a fixture-shaped driver identity would go live in production.
 * No-op outside production or when test fixtures are explicitly allowed.
 */
export function assertNotTestFixture(input: {
  fullName?: string | null;
  phone?: string | null;
  plateNumber?: string | null;
  context: string;
}): void {
  const isProd = process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';
  if (!isProd || process.env.ALLOW_TEST_FIXTURES === '1') return;
  if (isTestFixtureIdentity(input)) {
    throw new Error(
      `[fixture-guard] Refusing ${input.context}: identity matches test-fixture patterns in production`,
    );
  }
}
