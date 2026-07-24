import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState } from 'react-native';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import type { DriverStatus, Coordinates } from '@takeme/shared';
import { ApiClient, ApiError, API, DRIVER_LOCATION_INTERVAL_MS, LOCATION_THROTTLE_MS } from '@takeme/shared';
import { getClerkToken } from '@/lib/clerk';
import { heartbeatPayload, shouldSendHeartbeat } from '@/lib/location-heartbeat';
import type { ActivationState } from '@/types/onboarding';
import { useAuth } from './auth';

const BACKGROUND_LOCATION_TASK = 'DRIVER_LOCATION_BROADCAST';
const FIRST_FIX_TIMEOUT_MS = 20_000;

export type LocationPermission = 'undetermined' | 'granted' | 'denied';
export type LocationStatus = 'idle' | 'locating' | 'available' | 'timeout';

interface DriverStatusState {
  status: DriverStatus;
  location: Coordinates | null;
  locationPermission: LocationPermission;
  /** Lifecycle of the current fix attempt — never an endless spinner. */
  locationStatus: LocationStatus;
  isLocationPermitted: boolean;
  isBackgroundPermitted: boolean;
  loading: boolean;
  error: string | null;
  /** Set when the server refuses `available` with a 403 activation payload. */
  activationBlock: ActivationState | null;
}

interface DriverStatusContextValue extends DriverStatusState {
  goOnline: () => Promise<void>;
  goOffline: () => Promise<void>;
  clearActivationBlock: () => void;
  /** Contextual permission request — call from UI with an explanation shown. */
  requestLocationPermission: () => Promise<boolean>;
  /** Restart the fix attempt after a timeout. */
  retryLocation: () => void;
}

const DriverStatusContext = createContext<DriverStatusContextValue | null>(null);

export function DriverStatusProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();

  const [state, setState] = useState<DriverStatusState>({
    status: 'offline',
    location: null,
    locationPermission: 'undetermined',
    locationStatus: 'idle',
    isLocationPermitted: false,
    isBackgroundPermitted: false,
    loading: false,
    error: null,
    activationBlock: null,
  });
  const [watchGeneration, setWatchGeneration] = useState(0);

  // Foreground heartbeat bookkeeping. The status lives in a ref so the
  // long-lived watch callback always sees the current value.
  const statusRef = useRef(state.status);
  statusRef.current = state.status;
  const lastHeartbeatAtRef = useRef<number | null>(null);

  const apiClient = useMemo(
    () =>
      new ApiClient({
        baseUrl: process.env.EXPO_PUBLIC_API_BASE_URL!,
        getAccessToken: getClerkToken,
      }),
    [],
  );

  // ROOT-CAUSE FIX: the foreground watch previously only updated local state;
  // the server POST lived solely in the background task, which requires the
  // "Always" permission — a While-Using driver was invisible to dispatch.
  // Online drivers now heartbeat from the foreground watch too, throttled.
  const sendHeartbeat = useCallback(
    (coords: { latitude: number; longitude: number; heading?: number | null; speed?: number | null }) => {
      const now = Date.now();
      if (
        !shouldSendHeartbeat({
          status: statusRef.current,
          lastSentAt: lastHeartbeatAtRef.current,
          now,
          throttleMs: LOCATION_THROTTLE_MS,
        })
      ) {
        return;
      }
      lastHeartbeatAtRef.current = now;
      apiClient.post(API.DRIVER_LOCATION, heartbeatPayload(coords)).catch(() => {
        // Heartbeats are periodic — the next one retries; allow it promptly.
        lastHeartbeatAtRef.current = null;
      });
    },
    [apiClient],
  );

  const applyPermission = useCallback((status: Location.PermissionStatus) => {
    const permission: LocationPermission =
      status === Location.PermissionStatus.GRANTED
        ? 'granted'
        : status === Location.PermissionStatus.DENIED
          ? 'denied'
          : 'undetermined';
    setState((prev) => ({
      ...prev,
      locationPermission: permission,
      isLocationPermitted: permission === 'granted',
    }));
    return permission;
  }, []);

  // CHECK (never request) permission on mount, and re-check when the app
  // returns to the foreground — that's how a Settings round-trip lands.
  useEffect(() => {
    let alive = true;
    const check = async () => {
      const fg = await Location.getForegroundPermissionsAsync();
      if (!alive) return;
      applyPermission(fg.status);
      const bg = await Location.getBackgroundPermissionsAsync();
      if (!alive) return;
      setState((prev) => ({ ...prev, isBackgroundPermitted: bg.status === 'granted' }));
    };
    void check();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void check();
    });
    return () => {
      alive = false;
      sub.remove();
    };
  }, [applyPermission]);

  const requestLocationPermission = useCallback(async (): Promise<boolean> => {
    const fg = await Location.requestForegroundPermissionsAsync();
    return applyPermission(fg.status) === 'granted';
  }, [applyPermission]);

  // Fetch current driver status on login. The endpoint wraps the record in
  // { driver: { status } } — parsing that wrong left the toggle stuck on
  // "offline" after every app restart.
  useEffect(() => {
    if (!user) return;

    (async () => {
      try {
        const result = await apiClient.get<{ driver: { status: DriverStatus } }>(
          API.DRIVER_STATUS,
        );
        if (result?.driver?.status) {
          setState((prev) => ({ ...prev, status: result.driver.status }));
        }
      } catch {
        // If driver profile doesn't exist yet (onboarding), default offline
      }
    })();
  }, [user, apiClient]);

  // Foreground position watcher: runs whenever permission is granted — the
  // map needs a location for offline drivers too. Seeds from the last known
  // position for instant render, then live-updates; a fix attempt that gets
  // nothing within the timeout surfaces `timeout` instead of spinning.
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (state.locationPermission !== 'granted') {
      setState((prev) =>
        prev.locationStatus === 'idle' ? prev : { ...prev, locationStatus: 'idle' },
      );
      return;
    }

    let sub: Location.LocationSubscription | null = null;
    let alive = true;
    let gotFix = false;

    setState((prev) => ({
      ...prev,
      locationStatus: prev.location ? 'available' : 'locating',
    }));

    (async () => {
      const last = await Location.getLastKnownPositionAsync().catch(() => null);
      if (alive && last) {
        gotFix = true;
        setState((prev) => ({
          ...prev,
          location: {
            latitude: last.coords.latitude,
            longitude: last.coords.longitude,
          },
          locationStatus: 'available',
        }));
      }
      try {
        sub = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.Balanced,
            timeInterval: DRIVER_LOCATION_INTERVAL_MS,
            distanceInterval: 10,
          },
          (fix) => {
            if (!alive) return;
            gotFix = true;
            if (timeoutRef.current) clearTimeout(timeoutRef.current);
            setState((prev) => ({
              ...prev,
              location: { latitude: fix.coords.latitude, longitude: fix.coords.longitude },
              locationStatus: 'available',
            }));
            sendHeartbeat(fix.coords);
          },
        );
      } catch {
        if (alive && !gotFix) {
          setState((prev) => ({ ...prev, locationStatus: 'timeout' }));
        }
      }
    })();

    timeoutRef.current = setTimeout(() => {
      if (alive && !gotFix) {
        setState((prev) => ({ ...prev, locationStatus: 'timeout' }));
      }
    }, FIRST_FIX_TIMEOUT_MS);

    return () => {
      alive = false;
      sub?.remove();
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [state.locationPermission, watchGeneration, sendHeartbeat]);

  const retryLocation = useCallback(() => {
    setWatchGeneration((generation) => generation + 1);
  }, []);

  const goOnline = useCallback(async () => {
    if (state.locationPermission !== 'granted') {
      setState((prev) => ({
        ...prev,
        error: 'Location permission required to go online',
      }));
      return;
    }

    setState((prev) => ({ ...prev, loading: true, error: null, activationBlock: null }));
    try {
      // Update server status
      await apiClient.put(API.DRIVER_STATUS, { status: 'available' });

      // Background broadcasting needs Always permission; request it here, in
      // context, the first time the driver actually goes online.
      let backgroundPermitted = state.isBackgroundPermitted;
      if (!backgroundPermitted) {
        const bg = await Location.requestBackgroundPermissionsAsync();
        backgroundPermitted = bg.status === 'granted';
        setState((prev) => ({ ...prev, isBackgroundPermitted: backgroundPermitted }));
      }
      if (backgroundPermitted) {
        await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
          accuracy: Location.Accuracy.High,
          timeInterval: DRIVER_LOCATION_INTERVAL_MS,
          distanceInterval: 10,
          foregroundService: {
            notificationTitle: 'TAKEME Driver',
            notificationBody: "You're online and receiving ride requests",
            notificationColor: '#111111',
          },
          showsBackgroundLocationIndicator: true,
        });
      }

      setState((prev) => ({ ...prev, status: 'available', loading: false }));
      statusRef.current = 'available';

      // Dispatch only sees drivers with a heartbeat fresher than 60s — send
      // one right now instead of waiting for the next watch tick.
      lastHeartbeatAtRef.current = null;
      const seed =
        (await Location.getLastKnownPositionAsync().catch(() => null)) ??
        (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }).catch(() => null));
      if (seed) sendHeartbeat(seed.coords);
    } catch (err) {
      // The platform refuses `available` until the driver is activated; the
      // 403 body carries the activation decision so the UI can route to the
      // Activation Center instead of showing a bare error string.
      if (err instanceof ApiError && err.status === 403) {
        const body = err.body as { activation?: ActivationState } | null;
        if (body?.activation) {
          const activation = body.activation;
          setState((prev) => ({
            ...prev,
            loading: false,
            error: null,
            activationBlock: activation,
          }));
          return;
        }
      }
      setState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to go online',
      }));
    }
  }, [state.locationPermission, state.isBackgroundPermitted, apiClient, sendHeartbeat]);

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

  const clearActivationBlock = useCallback(() => {
    setState((prev) => ({ ...prev, activationBlock: null }));
  }, []);

  const value = useMemo(
    () => ({
      ...state,
      goOnline,
      goOffline,
      clearActivationBlock,
      requestLocationPermission,
      retryLocation,
    }),
    [state, goOnline, goOffline, clearActivationBlock, requestLocationPermission, retryLocation],
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
