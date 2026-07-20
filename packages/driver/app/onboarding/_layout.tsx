import React from 'react';
import { Redirect, Stack } from 'expo-router';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useAuth } from '@/providers/auth';
import { colors } from '@/theme';
import { typography } from '@/theme/typography';

/**
 * The Activation Center lives OUTSIDE the (auth) and (app) groups on purpose:
 * (auth) bounces signed-in users to the dashboard, and (app) assumes an
 * activated driver. This group only requires a signed-in user; the index
 * screen itself sends fully-activated drivers on to the dashboard.
 *
 * Navigation: one native stack. Every task screen gets the native header —
 * iOS chevron back (accessible, 44pt, swipe-back enabled), Android system
 * back pops the same stack. The Activation Center is the root: no back
 * button there (it has its own header with Help/Account).
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
        headerShown: true,
        headerShadowVisible: false,
        headerTintColor: colors.text,
        headerStyle: { backgroundColor: colors.background },
        headerTitleStyle: { ...typography.bodyBold, color: colors.text },
        headerBackButtonDisplayMode: 'minimal',
        contentStyle: { backgroundColor: colors.background },
        animation: 'slide_from_right',
        gestureEnabled: true,
      }}
    >
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="market" options={{ title: 'Your market' }} />
      <Stack.Screen name="path" options={{ title: 'How you’ll drive' }} />
      <Stack.Screen name="profile" options={{ title: 'About you' }} />
      <Stack.Screen name="legal" options={{ title: 'Agreements' }} />
      <Stack.Screen name="vehicle" options={{ title: 'Your vehicle' }} />
      <Stack.Screen name="document" options={{ title: 'Documents' }} />
      <Stack.Screen name="background" options={{ title: 'Background check' }} />
      <Stack.Screen name="training" options={{ title: 'Training' }} />
      <Stack.Screen name="notifications" options={{ title: 'Notifications' }} />
    </Stack>
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
