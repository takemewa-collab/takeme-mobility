import React, { useEffect } from 'react';
import { Redirect, Stack } from 'expo-router';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '@/providers/auth';
import { useDriverStatus } from '@/providers/driver-status';
import { useOnboarding } from '@/providers/onboarding';
import { decideDestination, mustForceOffline } from '@/lib/activation-route';
import { colors } from '@/theme/colors';
import { typography } from '@/theme/typography';
import { spacing, borderRadius } from '@/theme/spacing';

/**
 * Activation gate for the operational app group.
 * Identity (Clerk) only gets a driver to the door; the server's activation
 * decision opens it. With no decision available — still loading or the
 * request failed — we fail closed and never show the dashboard.
 */
export default function DriverAppLayout() {
  const { user, initialized } = useAuth();
  const { state, loading, error, refresh } = useOnboarding();
  const { status, goOffline } = useDriverStatus();

  // A driver mid-trip finishes the trip even if a requirement lapsed; the
  // gate re-engages the moment the trip ends.
  const onActiveTrip = status === 'on_trip' || status === 'busy';

  // Suspension / expiry forces an online driver offline (server also refuses
  // dispatch; this keeps the client honest).
  useEffect(() => {
    if (!onActiveTrip && status === 'available' && mustForceOffline(state)) {
      void goOffline();
    }
  }, [state, status, onActiveTrip, goOffline]);

  if (!initialized) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  if (!user) {
    return <Redirect href="/(auth)/login" />;
  }

  const destination = decideDestination(state);

  if (destination === 'blocked' && !onActiveTrip) {
    if (loading || !error) {
      return (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.accent} />
          <Text style={styles.checking}>Checking your account…</Text>
        </View>
      );
    }
    return (
      <View style={styles.center}>
        <Text style={styles.errorTitle}>We couldn’t confirm your account</Text>
        <Text style={styles.errorBody}>
          Check your connection and try again. You can’t go online until your
          account is confirmed.
        </Text>
        <Pressable
          accessibilityRole="button"
          style={({ pressed }) => [styles.retry, pressed && styles.retryPressed]}
          onPress={() => void refresh()}
        >
          <Text style={styles.retryText}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  if (destination === 'onboarding' && !onActiveTrip) {
    return <Redirect href="/onboarding" />;
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="trip" options={{ presentation: 'fullScreenModal' }} />
    </Stack>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
    padding: spacing['3xl'],
    gap: spacing.lg,
  },
  checking: { ...typography.caption, color: colors.textSecondary },
  errorTitle: { ...typography.h3, color: colors.text, textAlign: 'center' },
  errorBody: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
  },
  retry: {
    minHeight: 48,
    minWidth: 160,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: borderRadius.lg,
    backgroundColor: colors.primary,
    paddingHorizontal: spacing['2xl'],
    marginTop: spacing.md,
  },
  retryPressed: { opacity: 0.85 },
  retryText: { ...typography.bodyBold, color: colors.white },
});
