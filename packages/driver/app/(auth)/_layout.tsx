import React from 'react';
import { Redirect, Stack } from 'expo-router';
import { useAuth } from '@/providers/auth';
import { ActivityIndicator, View, StyleSheet } from 'react-native';
import { colors } from '@/theme/colors';

export default function AuthLayout() {
  const { user, loading, initialized } = useAuth();

  if (!initialized || loading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  if (user) {
    // Never assume activation from a session: the Activation Center is the
    // routing choke point and forwards eligible drivers to the dashboard.
    return <Redirect href="/onboarding" />;
  }

  return (
    <Stack screenOptions={{ headerShown: false, animation: 'slide_from_right' }}>
      <Stack.Screen name="login" />
      <Stack.Screen name="phone" />
      <Stack.Screen name="verify" />
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
