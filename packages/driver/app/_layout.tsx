import React, { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { StyleSheet } from 'react-native';
// Side-effect import: registers the background location task via
// TaskManager.defineTask at module load, BEFORE startLocationUpdatesAsync runs.
// Without this the task is never defined and background broadcasting throws
// "task not found" — the driver's location never reaches riders.
import '@/tasks/background-location';
import { SupabaseProvider } from '@/providers/supabase';
import { AuthProvider } from '@/providers/auth';
import { DriverStatusProvider } from '@/providers/driver-status';
import { TripProvider } from '@/providers/trip';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  useEffect(() => {
    SplashScreen.hideAsync();
  }, []);

  return (
    <GestureHandlerRootView style={styles.root}>
      <SupabaseProvider>
        <AuthProvider>
          <DriverStatusProvider>
            <TripProvider>
              <StatusBar style="dark" />
              <Stack screenOptions={{ headerShown: false }}>
                <Stack.Screen name="(auth)" />
                <Stack.Screen name="(app)" />
              </Stack>
            </TripProvider>
          </DriverStatusProvider>
        </AuthProvider>
      </SupabaseProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
