import React from 'react';
import { Redirect, Stack } from 'expo-router';
import { useAuth } from '@/providers/auth';
import { usePushNotifications } from '@/hooks/usePushNotifications';
import { ActivityIndicator, View, StyleSheet } from 'react-native';

export default function AppLayout() {
  const { user, initialized } = useAuth();
  usePushNotifications();

  if (!initialized) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#3B82F6" />
      </View>
    );
  }

  if (!user) {
    return <Redirect href="/(auth)/welcome" />;
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="ride" options={{ presentation: 'fullScreenModal' }} />
    </Stack>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' },
});
