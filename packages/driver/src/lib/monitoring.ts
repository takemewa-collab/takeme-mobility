import * as Sentry from '@sentry/react-native';

const DSN = process.env.EXPO_PUBLIC_SENTRY_DSN ?? '';

/** Crash + error monitoring. No-ops until EXPO_PUBLIC_SENTRY_DSN is set. */
export function initMonitoring() {
  if (!DSN) return;
  Sentry.init({
    dsn: DSN,
    environment: process.env.EXPO_PUBLIC_AUTH_MODE === 'production' ? 'production' : 'development',
    tracesSampleRate: 0.2,
    sendDefaultPii: false,
  });
}

export const withMonitoring = DSN ? Sentry.wrap : <T,>(c: T): T => c;

export function reportError(error: unknown, context?: Record<string, unknown>) {
  if (!DSN) return;
  Sentry.captureException(error, context ? { extra: context } : undefined);
}
