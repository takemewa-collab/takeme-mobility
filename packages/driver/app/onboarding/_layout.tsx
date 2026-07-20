import React from 'react';
import { Redirect, Stack } from 'expo-router';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useAuth } from '@/providers/auth';
import { colors } from '@/theme';

/**
 * The Activation Center lives OUTSIDE the (auth) and (app) groups on purpose:
 * (auth) bounces signed-in users to the dashboard, and (app) assumes an
 * activated driver. This group only requires a signed-in user; the index
 * screen itself sends fully-activated drivers on to the dashboard.
 */
export default function OnboardingLayout() {
  const { user, initialized } = useAuth();

  if (!initialized) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (!user) {
    return <Redirect href="/(auth)/login" />;
  }

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        animation: 'slide_from_right',
        contentStyle: { backgroundColor: colors.background },
      }}
    />
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
});
