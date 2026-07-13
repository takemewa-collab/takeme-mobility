import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import type { DriverStatus, Coordinates } from '@takeme/shared';
import { ApiClient, API, DRIVER_LOCATION_INTERVAL_MS } from '@takeme/shared';
import { useSupabase } from './supabase';
import { useAuth } from './auth';

const BACKGROUND_LOCATION_TASK = 'DRIVER_LOCATION_BROADCAST';

interface DriverStatusState {
  status: DriverStatus;
  location: Coordinates | null;
  isLocationPermitted: boolean;
  isBackgroundPermitted: boolean;
  loading: boolean;
  error: string | null;
}

interface DriverStatusContextValue extends DriverStatusState {
  goOnline: () => Promise<void>;
  goOffline: () => Promise<void>;
}

const DriverStatusContext = createContext<DriverStatusContextValue | null>(null);

export function DriverStatusProvider({ children }: { children: React.ReactNode }) {
  const supabase = useSupabase();
  const { session } = useAuth();

  const [state, setState] = useState<DriverStatusState>({
    status: 'offline',
    location: null,
    isLocationPermitted: false,
    isBackgroundPermitted: false,
    loading: false,
    error: null,
  });

  const apiClient = useMemo(
    () =>
      new ApiClient({
        baseUrl: process.env.EXPO_PUBLIC_API_BASE_URL!,
        getAccessToken: async () => {
          const { data } = await supabase.auth.getSession();
          return data.session?.access_token ?? null;
        },
      }),
    [supabase],
  );

  // Request location permissions on mount
  useEffect(() => {
    (async () => {
      const fg = await Location.requestForegroundPermissionsAsync();
      const fgGranted = fg.status === 'granted';
      setState((prev) => ({ ...prev, isLocationPermitted: fgGranted }));

      if (fgGranted) {
        const bg = await Location.requestBackgroundPermissionsAsync();
        setState((prev) => ({
          ...prev,
          isBackgroundPermitted: bg.status === 'granted',
        }));
      }
    })();
  }, []);

  // Fetch current driver status on login
  useEffect(() => {
    if (!session) return;

    (async () => {
      try {
        const result = await apiClient.get<{ status: DriverStatus }>(
          API.DRIVER_STATUS,
        );
        setState((prev) => ({ ...prev, status: result.status }));
      } catch {
        // If driver profile doesn't exist yet (onboarding), default offline
      }
    })();
  }, [session, apiClient]);

  const goOnline = useCallback(async () => {
    if (!state.isLocationPermitted) {
      setState((prev) => ({
        ...prev,
        error: 'Location permission required to go online',
      }));
      return;
    }

    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      // Update server status
      await apiClient.put(API.DRIVER_STATUS, { status: 'available' });

      // Start background location broadcasting
      if (state.isBackgroundPermitted) {
        await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
          accuracy: Location.Accuracy.High,
          timeInterval: DRIVER_LOCATION_INTERVAL_MS,
          distanceInterval: 10,
          foregroundService: {
            notificationTitle: 'Takeme Driver',
            notificationBody: "You're online and receiving ride requests",
            notificationColor: '#111111',
          },
          showsBackgroundLocationIndicator: true,
        });
      }

      setState((prev) => ({ ...prev, status: 'available', loading: false }));
    } catch (err) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to go online',
      }));
    }
  }, [state.isLocationPermitted, state.isBackgroundPermitted, apiClient]);

  const goOffline = useCallback(async () => {
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      await apiClient.put(API.DRIVER_STATUS, { status: 'offline' });

      // Stop background location
      const isRegistered = await TaskManager.isTaskRegisteredAsync(
        BACKGROUND_LOCATION_TASK,
      );
      if (isRegistered) {
        await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
      }

      setState((prev) => ({ ...prev, status: 'offline', loading: false }));
    } catch (err) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to go offline',
      }));
    }
  }, [apiClient]);

  const value = useMemo(
    () => ({ ...state, goOnline, goOffline }),
    [state, goOnline, goOffline],
  );

  return (
    <DriverStatusContext.Provider value={value}>
      {children}
    </DriverStatusContext.Provider>
  );
}

export function useDriverStatus(): DriverStatusContextValue {
  const ctx = useContext(DriverStatusContext);
  if (!ctx) {
    throw new Error(
      'useDriverStatus must be used within a DriverStatusProvider',
    );
  }
  return ctx;
}
