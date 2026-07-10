import React from 'react';
import { Redirect, Stack } from 'expo-router';
import { useAuth } from '@/providers/auth';
import { usePushNotifications } from '@/hooks/usePushNotifications';
import { ActivityIndicator, View, StyleSheet } from 'react-native';
import { colors } from '@/theme/colors';

export default function DriverAppLayout() {
  const { user, initialized } = useAuth();
  usePushNotifications();

  if (!initialized) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  if (!user) {
    return <Redirect href="/(auth)/login" />;
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen
        name="trip"
        options={{ presentation: 'fullScreenModal' }}
      />
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
