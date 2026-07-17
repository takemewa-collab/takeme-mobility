import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { AppState } from 'react-native';
import type { Ride, RideStatus } from '@takeme/shared';
import { ApiClient, API } from '@takeme/shared';
import { getClerkToken } from '@/lib/clerk';
import { useSupabase } from './supabase';
import { useAuth } from './auth';

const DRIVER_ACTIVE_STATUSES: RideStatus[] = [
  'driver_assigned',
  'driver_arriving',
  'arrived',
  'in_progress',
];

interface RiderInfo {
  name: string;
  rating: number;
}

interface TripState {
  activeTrip: Ride | null;
  riderInfo: RiderInfo | null;
  loading: boolean;
  error: string | null;
}

type TripAction =
  | { type: 'SET_TRIP'; trip: Ride | null }
  | { type: 'SET_RIDER_INFO'; info: RiderInfo | null }
  | { type: 'SET_LOADING'; loading: boolean }
  | { type: 'SET_ERROR'; error: string | null }
  | { type: 'CLEAR' };

function tripReducer(state: TripState, action: TripAction): TripState {
  switch (action.type) {
    case 'SET_TRIP':
      return { ...state, activeTrip: action.trip, error: null };
    case 'SET_RIDER_INFO':
      return { ...state, riderInfo: action.info };
    case 'SET_LOADING':
      return { ...state, loading: action.loading };
    case 'SET_ERROR':
      return { ...state, error: action.error, loading: false };
    case 'CLEAR':
      return { activeTrip: null, riderInfo: null, loading: false, error: null };
    default:
      return state;
  }
}

interface TripContextValue extends TripState {
  restoreActiveTrip: () => Promise<void>;
  clearTrip: () => void;
  apiClient: ApiClient | null;
}

const TripContext = createContext<TripContextValue | null>(null);

export function TripProvider({ children }: { children: React.ReactNode }) {
  const supabase = useSupabase();
  const { user } = useAuth();
  const [state, dispatch] = useReducer(tripReducer, {
    activeTrip: null,
    riderInfo: null,
    loading: false,
    error: null,
  });

  const apiClient = useMemo(() => {
    const baseUrl = process.env.EXPO_PUBLIC_API_BASE_URL;
    if (!baseUrl) return null;
    return new ApiClient({
      baseUrl,
      getAccessToken: getClerkToken,
    });
  }, []);

  // Fetch rider info for the active trip
  const fetchRiderInfo = useCallback(async (riderId: string) => {
    try {
      const { data } = await supabase
        .from('riders')
        .select('full_name, rating')
        .eq('id', riderId)
        .single();

      if (data) {
        dispatch({
          type: 'SET_RIDER_INFO',
          info: {
            name: data.full_name ?? 'Rider',
            rating: Number(data.rating ?? 5),
          },
        });
      }
    } catch (err) {
      console.error('Failed to fetch rider info:', err);
    }
  }, [supabase]);

  const restoreActiveTrip = useCallback(async () => {
    if (!user) return;

    dispatch({ type: 'SET_LOADING', loading: true });
    try {
      // Try API first for richer data
      if (apiClient) {
        try {
          const data = await apiClient.get<{ ride: Ride; rider_name?: string; rider_rating?: number }>(API.DRIVER_RIDES);
          if (data?.ride) {
            dispatch({ type: 'SET_TRIP', trip: data.ride });
            if (data.ride.rider_id) {
              await fetchRiderInfo(data.ride.rider_id);
            }
            dispatch({ type: 'SET_LOADING', loading: false });
            return;
          }
        } catch {
          // Fallback to direct Supabase query
        }
      }

      // Fallback: direct Supabase query
      const { data: driver } = await supabase
        .from('drivers')
        .select('id')
        .eq('auth_user_id', user.id)
        .maybeSingle();

      if (!driver) {
        dispatch({ type: 'SET_LOADING', loading: false });
        return;
      }

      const { data: ride, error } = await supabase
        .from('rides')
        .select('*')
        .eq('assigned_driver_id', driver.id)
        .in('status', DRIVER_ACTIVE_STATUSES)
        .order('driver_assigned_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) throw error;
      dispatch({ type: 'SET_TRIP', trip: ride });

      if (ride?.rider_id) {
        await fetchRiderInfo(ride.rider_id);
      }
    } catch (err) {
      console.error('Failed to restore active trip:', err);
      dispatch({ type: 'SET_ERROR', error: 'Failed to restore trip' });
    } finally {
      dispatch({ type: 'SET_LOADING', loading: false });
    }
  }, [user, supabase, apiClient, fetchRiderInfo]);

  const clearTrip = useCallback(() => {
    dispatch({ type: 'CLEAR' });
  }, []);

  // Resolve this driver's row id once per session — assignment events are keyed
  // on drivers.id, not the auth user id.
  const [driverId, setDriverId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!user) {
      setDriverId(null);
      return;
    }
    (async () => {
      const { data } = await supabase
        .from('drivers')
        .select('id')
        .eq('auth_user_id', user.id)
        .maybeSingle();
      if (!cancelled) setDriverId(data?.id ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [user, supabase]);

  // Watch for a ride being ASSIGNED to this driver while idle. Without this an
  // idle driver only discovers new rides on re-login — the dispatch auto-assign
  // would strand the ride. Any insert/update that lands an active ride on this
  // driver becomes the activeTrip, and dashboard auto-navigates to /incoming.
  const activeTripId = state.activeTrip?.id ?? null;
  useEffect(() => {
    if (!driverId) return;

    const channel = supabase
      .channel(`driver_assignments:${driverId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'rides',
          filter: `assigned_driver_id=eq.${driverId}`,
        },
        (payload) => {
          const ride = payload.new as Ride;
          if (!ride?.id) return;
          if (!DRIVER_ACTIVE_STATUSES.includes(ride.status)) return;
          if (ride.id === activeTripId) return; // already tracked by the other channel
          dispatch({ type: 'SET_TRIP', trip: ride });
          if (ride.rider_id) fetchRiderInfo(ride.rider_id);
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [driverId, activeTripId, supabase, fetchRiderInfo]);

  // On return to the foreground, re-sync in case realtime dropped events while
  // backgrounded (also the polling-style safety net if the socket was down).
  const restoreRef = useRef(restoreActiveTrip);
  restoreRef.current = restoreActiveTrip;
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') restoreRef.current();
    });
    return () => sub.remove();
  }, []);

  // Subscribe to realtime trip updates
  useEffect(() => {
    if (!state.activeTrip) return;

    const channel = supabase
      .channel(`driver_trip:${state.activeTrip.id}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'rides',
          filter: `id=eq.${state.activeTrip.id}`,
        },
        (payload) => {
          const updated = payload.new as Ride;
          dispatch({ type: 'SET_TRIP', trip: updated });
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [state.activeTrip?.id, supabase]);

  // Restore on login
  useEffect(() => {
    if (user) {
      restoreActiveTrip();
    } else {
      dispatch({ type: 'CLEAR' });
    }
  }, [user, restoreActiveTrip]);

  const value = useMemo(
    () => ({ ...state, restoreActiveTrip, clearTrip, apiClient }),
    [state, restoreActiveTrip, clearTrip, apiClient],
  );

  return (
    <TripContext.Provider value={value}>
      {children}
    </TripContext.Provider>
  );
}

export function useTrip(): TripContextValue {
  const ctx = useContext(TripContext);
  if (!ctx) {
    throw new Error('useTrip must be used within a TripProvider');
  }
  return ctx;
}
