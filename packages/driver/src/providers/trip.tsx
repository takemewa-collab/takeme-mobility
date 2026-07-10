import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
} from 'react';
import type { Ride, RideStatus } from '@takeme/shared';
import { ApiClient, API } from '@takeme/shared';
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
  phone: string;
  rating: number;
}

/** Payload of a `ride_request` push notification (offer not yet accepted). */
export interface IncomingOffer {
  rideId: string;
  pickupAddress: string;
  dropoffAddress: string;
  estimatedFare?: number;
  distanceKm?: number;
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
  setIncomingOffer: (offer: IncomingOffer) => void;
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
      getAccessToken: async () => {
        const { data } = await supabase.auth.getSession();
        return data.session?.access_token ?? null;
      },
    });
  }, [supabase]);

  // Fetch rider info for the active trip
  const fetchRiderInfo = useCallback(async (riderId: string) => {
    try {
      const { data } = await supabase
        .from('riders')
        .select('full_name, phone, rating')
        .eq('id', riderId)
        .single();

      if (data) {
        dispatch({
          type: 'SET_RIDER_INFO',
          info: {
            name: data.full_name ?? 'Rider',
            phone: data.phone ?? '',
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

  // Offered rides aren't assigned yet, so they can't be fetched via
  // GET /api/driver/rides — build the trip from the push payload instead.
  // The incoming screen only renders addresses, distance and fare.
  const setIncomingOffer = useCallback((offer: IncomingOffer) => {
    const now = new Date().toISOString();
    const trip = {
      id: offer.rideId,
      rider_id: '',
      assigned_driver_id: null,
      vehicle_id: null,
      quote_id: null,
      status: 'searching_driver',
      vehicle_class: 'electric',
      pickup_lat: 0,
      pickup_lng: 0,
      pickup_address: offer.pickupAddress,
      dropoff_lat: 0,
      dropoff_lng: 0,
      dropoff_address: offer.dropoffAddress,
      distance_km: offer.distanceKm ?? null,
      duration_min: null,
      estimated_fare: offer.estimatedFare ?? null,
      final_fare: null,
      surge_multiplier: 1,
      requested_at: now,
      driver_assigned_at: null,
      driver_arrived_at: null,
      trip_started_at: null,
      trip_completed_at: null,
      cancelled_at: null,
      cancel_reason: null,
      cancelled_by: null,
      rider_rating: null,
      driver_rating: null,
    } as Ride;
    dispatch({ type: 'SET_TRIP', trip });
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
    () => ({ ...state, restoreActiveTrip, clearTrip, setIncomingOffer, apiClient }),
    [state, restoreActiveTrip, clearTrip, setIncomingOffer, apiClient],
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
