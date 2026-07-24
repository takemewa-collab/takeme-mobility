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
import type {
  AirportContext,
  Ride,
  RidePreferences,
  RideStatus,
  RoutePoint,
  RoutePointStatus,
} from '@takeme/shared';
import { router } from 'expo-router';
import { ApiClient, API, DISPATCH } from '@takeme/shared';
import { getClerkToken } from '@/lib/clerk';
import { startOfferAlert, stopOfferAlert } from '@/lib/offer-alert';
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

/**
 * The active trip always carries its (possibly empty) multi-stop itinerary,
 * airport contexts, and rider preference flags.
 */
export type ActiveTrip = Ride & {
  route_points: RoutePoint[];
  airport_contexts: AirportContext[];
  preferences: RidePreferences;
};

interface TripState {
  activeTrip: ActiveTrip | null;
  riderInfo: RiderInfo | null;
  loading: boolean;
  error: string | null;
}

type TripAction =
  | { type: 'SET_TRIP'; trip: Ride | null }
  | { type: 'SET_POINTS'; rideId: string; points: RoutePoint[] }
  | { type: 'UPSERT_POINT'; rideId: string; point: RoutePoint }
  | { type: 'SET_POINT_STATUS'; pointId: string; status: RoutePointStatus }
  | { type: 'SET_AIRPORT_CONTEXTS'; rideId: string; contexts: AirportContext[] }
  | { type: 'SET_RIDER_INFO'; info: RiderInfo | null }
  | { type: 'SET_LOADING'; loading: boolean }
  | { type: 'SET_ERROR'; error: string | null }
  | { type: 'CLEAR' };

/**
 * Realtime payloads and direct PostgREST reads can deliver numeric columns as
 * strings; coerce so the rest of the app can trust RoutePoint's number fields.
 */
function normalizeRoutePoint(raw: Record<string, unknown> | null | undefined): RoutePoint | null {
  if (!raw || typeof raw.id !== 'string') return null;
  return {
    id: raw.id,
    point_type: raw.point_type as RoutePoint['point_type'],
    seq: Number(raw.seq),
    place_name: (raw.place_name as string | null) ?? null,
    formatted_address: String(raw.formatted_address ?? ''),
    lat: Number(raw.lat),
    lng: Number(raw.lng),
    leg_distance_km: raw.leg_distance_km == null ? null : Number(raw.leg_distance_km),
    leg_duration_min: raw.leg_duration_min == null ? null : Number(raw.leg_duration_min),
    status: raw.status as RoutePoint['status'],
    arrived_at: (raw.arrived_at as string | null) ?? null,
    completed_at: (raw.completed_at as string | null) ?? null,
  };
}

/**
 * Preference flags arrive either as `ride.preferences` (GET /api/driver/rides,
 * rides row) or as a flat `pet_friendly` boolean on the incoming-offer payload.
 * Returns null when the source carried no preference data at all, so the
 * reducer can keep already-known flags instead of wiping them.
 */
function normalizeRidePreferences(
  raw: Ride & { pet_friendly?: unknown },
): RidePreferences | null {
  if (raw.preferences && typeof raw.preferences === 'object') {
    return {
      ...(typeof raw.preferences.pet_friendly === 'boolean'
        ? { pet_friendly: raw.preferences.pet_friendly }
        : {}),
      ...(typeof raw.preferences.women_preferred === 'boolean'
        ? { women_preferred: raw.preferences.women_preferred }
        : {}),
    };
  }
  if (typeof raw.pet_friendly === 'boolean') {
    return { pet_friendly: raw.pet_friendly };
  }
  return null;
}

const bySeq = (a: RoutePoint, b: RoutePoint) => a.seq - b.seq;

function tripReducer(state: TripState, action: TripAction): TripState {
  switch (action.type) {
    case 'SET_TRIP': {
      if (!action.trip) return { ...state, activeTrip: null, error: null };
      // Ride-row realtime updates arrive without route_points or
      // airport_contexts — keep the ones we already have for the same ride
      // instead of wiping them.
      const prev = state.activeTrip;
      const sameRide = prev != null && prev.id === action.trip.id;
      const route_points = action.trip.route_points ?? (sameRide ? prev.route_points : []);
      const airport_contexts =
        action.trip.airport_contexts ?? (sameRide ? prev.airport_contexts : []);
      const preferences =
        normalizeRidePreferences(action.trip) ?? (sameRide ? prev.preferences : {});
      return {
        ...state,
        activeTrip: { ...action.trip, route_points, airport_contexts, preferences },
        error: null,
      };
    }
    case 'SET_POINTS': {
      if (!state.activeTrip || state.activeTrip.id !== action.rideId) return state;
      return {
        ...state,
        activeTrip: { ...state.activeTrip, route_points: [...action.points].sort(bySeq) },
      };
    }
    case 'UPSERT_POINT': {
      const trip = state.activeTrip;
      if (!trip || trip.id !== action.rideId) return state;
      const exists = trip.route_points.some((p) => p.id === action.point.id);
      const route_points = (
        exists
          ? trip.route_points.map((p) => (p.id === action.point.id ? action.point : p))
          : [...trip.route_points, action.point]
      ).sort(bySeq);
      return { ...state, activeTrip: { ...trip, route_points } };
    }
    case 'SET_POINT_STATUS': {
      const trip = state.activeTrip;
      if (!trip) return state;
      return {
        ...state,
        activeTrip: {
          ...trip,
          route_points: trip.route_points.map((p) =>
            p.id === action.pointId ? { ...p, status: action.status } : p,
          ),
        },
      };
    }
    case 'SET_AIRPORT_CONTEXTS': {
      if (!state.activeTrip || state.activeTrip.id !== action.rideId) return state;
      return {
        ...state,
        activeTrip: { ...state.activeTrip, airport_contexts: action.contexts },
      };
    }
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

/**
 * A dispatch OFFER while the ride is still `searching_driver`. It is NOT an
 * assigned trip — the ride has no assigned_driver_id yet, so the realtime
 * assignment channel can't see it. Two delivery paths feed the same state:
 * the push payload (immediate) and GET /api/driver/offer (restore after cold
 * start/reconnect + poll fallback), deduped by ride id.
 */
export interface IncomingOffer {
  rideId: string;
  pickupAddress: string;
  dropoffAddress: string;
  estimatedFare: number;
  /** Driver's ~80% share of the fare, when known (server-computed on restore). */
  estimatedEarnings: number | null;
  distanceKm: number | null;
  durationMin: number | null;
  pickupLat: number | null;
  pickupLng: number | null;
  /** Straight-line meters from the driver to the pickup at offer time. */
  pickupDistanceM: number | null;
  petFriendly: boolean;
  /** When the offer landed on the device. */
  receivedAt: number;
  /**
   * Server-authoritative expiry (epoch ms). Fallback when an old server
   * omitted it: receivedAt + ACCEPT_TIMEOUT_SEC.
   */
  expiresAt: number;
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Parse a push payload into an offer; null when it isn't a ride request. */
export function offerFromPushData(
  data: Record<string, unknown> | null | undefined,
): IncomingOffer | null {
  if (!data || data.type !== 'ride_request' || typeof data.rideId !== 'string') return null;
  const receivedAt = Date.now();
  return {
    rideId: data.rideId,
    pickupAddress: String(data.pickupAddress ?? 'Pickup'),
    dropoffAddress: String(data.dropoffAddress ?? 'Destination'),
    estimatedFare: num(data.estimatedFare) ?? 0,
    estimatedEarnings: null,
    distanceKm: num(data.distanceKm),
    durationMin: num(data.durationMin),
    pickupLat: num(data.pickupLat),
    pickupLng: num(data.pickupLng),
    pickupDistanceM: num(data.pickupDistanceM),
    petFriendly: data.petFriendly === true,
    receivedAt,
    expiresAt: num(data.expiresAt) ?? receivedAt + DISPATCH.ACCEPT_TIMEOUT_SEC * 1000,
  };
}

/** Server offer payload (GET /api/driver/offer) → IncomingOffer. */
export function offerFromServerPayload(
  offer: Record<string, unknown> | null | undefined,
): IncomingOffer | null {
  if (!offer || typeof offer.rideId !== 'string' || typeof offer.expiresAt !== 'number') return null;
  if (offer.expiresAt <= Date.now()) return null; // never surface an expired offer
  return {
    rideId: offer.rideId,
    pickupAddress: String(offer.pickupAddress ?? 'Pickup'),
    dropoffAddress: String(offer.dropoffAddress ?? 'Destination'),
    estimatedFare: num(offer.estimatedFare) ?? 0,
    estimatedEarnings: num(offer.estimatedEarnings),
    distanceKm: num(offer.distanceKm),
    durationMin: num(offer.durationMin),
    pickupLat: num(offer.pickupLat),
    pickupLng: num(offer.pickupLng),
    pickupDistanceM: num(offer.pickupDistanceM),
    petFriendly: offer.petFriendly === true,
    receivedAt: Date.now(),
    expiresAt: offer.expiresAt,
  };
}

interface TripContextValue extends TripState {
  restoreActiveTrip: () => Promise<void>;
  /** Full re-sync from the server — use after a 409 (state moved under us). */
  refreshTrip: () => Promise<void>;
  /** Apply a server-confirmed stop status locally without waiting for realtime. */
  markRoutePoint: (pointId: string, status: RoutePointStatus) => void;
  clearTrip: () => void;
  apiClient: ApiClient | null;
  /** Pending dispatch offer awaiting Accept/Decline (push-delivered). */
  incomingOffer: IncomingOffer | null;
  setIncomingOffer: (offer: IncomingOffer | null) => void;
}

const TripContext = createContext<TripContextValue | null>(null);

// Module-level presentation guard for incoming offers: which offer (ride id
// + expiry window) has already been presented (screen pushed + acks sent).
// Lives OUTSIDE React on purpose — it must survive both effect re-runs and
// provider remounts. A legitimate RE-offer of the same ride (after the
// dispatch cooldown) carries a new expiry window and presents again; the
// 2s tolerance absorbs the sub-second drift between the push payload's
// expiresAt and the server's authoritative one.
let presentedOfferRideId: string | null = null;
let presentedOfferExpiresAt = 0;

function isSamePresentation(rideId: string, expiresAt: number): boolean {
  return (
    presentedOfferRideId === rideId && Math.abs(presentedOfferExpiresAt - expiresAt) < 2000
  );
}

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

  // Direct read of the itinerary — used by the Supabase fallback path and when
  // a ride lands on us via the assignment channel (payload has no points).
  const fetchRoutePoints = useCallback(
    async (rideId: string): Promise<RoutePoint[]> => {
      const { data } = await supabase
        .from('ride_route_points')
        .select(
          'id, point_type, seq, place_name, formatted_address, lat, lng, leg_distance_km, leg_duration_min, status, arrived_at, completed_at',
        )
        .eq('ride_id', rideId)
        .order('seq', { ascending: true });
      return (data ?? [])
        .map((row) => normalizeRoutePoint(row as Record<string, unknown>))
        .filter((p): p is RoutePoint => p != null);
    },
    [supabase],
  );

  // Direct read of the trip's airport contexts (driver SELECT RLS). Snapshots
  // are immutable, so there is no realtime subscription — this runs on
  // restore/refresh and when a ride lands via the assignment channel. The
  // snapshot column is jsonb, so no numeric coercion is needed.
  const fetchAirportContexts = useCallback(
    async (rideId: string): Promise<AirportContext[]> => {
      const { data } = await supabase
        .from('trip_airport_context')
        .select('id, route_point_id, direction, flight_number, selection_method, snapshot')
        .eq('ride_id', rideId);
      return (data ?? []) as AirportContext[];
    },
    [supabase],
  );

  const restoreActiveTrip = useCallback(async () => {
    if (!user) return;

    dispatch({ type: 'SET_LOADING', loading: true });
    try {
      // Try API first for richer data
      if (apiClient) {
        try {
          const data = await apiClient.get<{ ride: Ride; rider_name?: string; rider_rating?: number }>(API.DRIVER_RIDES);
          if (data?.ride) {
            const route_points = (data.ride.route_points ?? [])
              .map((p) => normalizeRoutePoint(p as unknown as Record<string, unknown>))
              .filter((p): p is RoutePoint => p != null);
            const airport_contexts = data.ride.airport_contexts ?? [];
            dispatch({ type: 'SET_TRIP', trip: { ...data.ride, route_points, airport_contexts } });
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
      if (ride) {
        const [route_points, airport_contexts] = await Promise.all([
          fetchRoutePoints(ride.id),
          fetchAirportContexts(ride.id),
        ]);
        dispatch({ type: 'SET_TRIP', trip: { ...ride, route_points, airport_contexts } });
      } else {
        dispatch({ type: 'SET_TRIP', trip: null });
      }

      if (ride?.rider_id) {
        await fetchRiderInfo(ride.rider_id);
      }
    } catch (err) {
      console.error('Failed to restore active trip:', err);
      dispatch({ type: 'SET_ERROR', error: 'Failed to restore trip' });
    } finally {
      dispatch({ type: 'SET_LOADING', loading: false });
    }
  }, [user, supabase, apiClient, fetchRiderInfo, fetchRoutePoints, fetchAirportContexts]);

  const clearTrip = useCallback(() => {
    dispatch({ type: 'CLEAR' });
  }, []);

  const markRoutePoint = useCallback((pointId: string, status: RoutePointStatus) => {
    dispatch({ type: 'SET_POINT_STATUS', pointId, status });
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
          // The row payload carries no itinerary or airport contexts — load
          // them separately.
          fetchRoutePoints(ride.id).then((points) => {
            if (points.length > 0) {
              dispatch({ type: 'SET_POINTS', rideId: ride.id, points });
            }
          });
          fetchAirportContexts(ride.id).then((contexts) => {
            if (contexts.length > 0) {
              dispatch({ type: 'SET_AIRPORT_CONTEXTS', rideId: ride.id, contexts });
            }
          });
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [driverId, activeTripId, supabase, fetchRiderInfo, fetchRoutePoints, fetchAirportContexts]);

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
    const tripId = activeTripId;
    if (!tripId) return;

    const channel = supabase
      .channel(`driver_trip:${tripId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'rides',
          filter: `id=eq.${tripId}`,
        },
        (payload) => {
          const updated = payload.new as Ride;
          dispatch({ type: 'SET_TRIP', trip: updated });
        },
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'ride_route_points',
          filter: `ride_id=eq.${tripId}`,
        },
        (payload) => {
          const point = normalizeRoutePoint(payload.new as Record<string, unknown>);
          if (!point) return; // DELETE payloads carry no row — ignore
          dispatch({ type: 'UPSERT_POINT', rideId: tripId, point });
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [activeTripId, supabase]);

  // Restore on login
  useEffect(() => {
    if (user) {
      restoreActiveTrip();
    } else {
      dispatch({ type: 'CLEAR' });
    }
  }, [user, restoreActiveTrip]);

  // Pending dispatch offer. Push seeds it instantly; GET /api/driver/offer
  // restores it after cold start/reconnect and polls as a fallback. All
  // delivery paths funnel through presentOffer for dedupe + expiry policy.
  const [incomingOffer, setIncomingOfferState] = useState<IncomingOffer | null>(null);
  const incomingOfferRef = useRef<IncomingOffer | null>(null);
  incomingOfferRef.current = incomingOffer;
  const activeTripRef = useRef(state.activeTrip);
  activeTripRef.current = state.activeTrip;

  const setIncomingOffer = useCallback((offer: IncomingOffer | null) => {
    if (offer === null) {
      setIncomingOfferState(null);
      return;
    }
    // Never show an expired offer, never re-alert the ride we're already
    // showing, never surface an offer over an active trip.
    if (offer.expiresAt <= Date.now()) return;
    if (activeTripRef.current) return;
    const current = incomingOfferRef.current;
    if (current && current.rideId === offer.rideId) {
      // Same offer from a second channel — keep richer fields, no re-alert.
      if (offer.estimatedEarnings != null && current.estimatedEarnings == null) {
        setIncomingOfferState({ ...current, ...offer, receivedAt: current.receivedAt });
      }
      return;
    }
    setIncomingOfferState(offer);
  }, []);

  // Server-truth sync: restore the live offer after cold start/reconnect,
  // enrich push offers (estimated earnings, live pickup distance), and poll
  // while idle so a missed push is only ever seconds behind — and a ride
  // reassigned to another driver closes here immediately.
  const syncOfferFromServer = useCallback(async () => {
    if (!apiClient || !user || activeTripRef.current) return;
    const startedAt = Date.now();
    try {
      const res = await apiClient.get<{ offer: Record<string, unknown> | null }>(API.DRIVER_OFFER);
      const serverOffer = offerFromServerPayload(res?.offer);
      if (serverOffer) {
        setIncomingOffer(serverOffer);
      } else {
        // Only clear offers that existed before this request started — a push
        // landing mid-flight must not be wiped by a stale null.
        const current = incomingOfferRef.current;
        if (current && current.receivedAt < startedAt) {
          setIncomingOfferState(null);
        }
      }
    } catch {
      // Poll is a fallback path — silence transient failures.
    }
  }, [apiClient, user, setIncomingOffer]);

  // Alert + full-screen presentation lifecycle, keyed on the OFFER'S RIDE ID.
  //
  // HARD IDEMPOTENCY RULE (live incident, ride 38132b70): this effect cycled
  // ~2×/second in production — 26 duplicate offer_displayed acks, the sound
  // restarting each cycle, offer screens stacking. Presentation is therefore
  // guarded by a MODULE-LEVEL ride id (survives effect re-runs AND provider
  // remounts): navigation + acks happen at most once per offer, the sound is
  // a module singleton that auto-stops at the offer's server expiry, and the
  // effect cleanup no longer tears the alert down (a re-run must be a no-op).
  // The guard resets only on a MOUNTED offer-clear, so a legitimate re-offer
  // of the same ride after the cooldown alerts again.
  const offerRideId = incomingOffer?.rideId ?? null;
  const hadOfferThisInstanceRef = useRef(false);
  useEffect(() => {
    if (!offerRideId) {
      // Only a MOUNTED offer-clear (this instance saw the offer end) stops
      // the alert and resets the guard. A fresh mount that simply hasn't
      // restored the offer yet must leave a still-valid alert untouched —
      // tearing it down here is what a remount loop would amplify.
      if (hadOfferThisInstanceRef.current) {
        hadOfferThisInstanceRef.current = false;
        presentedOfferRideId = null;
        presentedOfferExpiresAt = 0;
        void stopOfferAlert();
      }
      return;
    }
    hadOfferThisInstanceRef.current = true;

    const expiresAt = incomingOfferRef.current?.expiresAt ?? Date.now();
    const firstPresentation = !isSamePresentation(offerRideId, expiresAt);

    if (firstPresentation) {
      presentedOfferRideId = offerRideId;
      presentedOfferExpiresAt = expiresAt;

      // Enrich a push-sourced offer with server-computed fields (earnings,
      // live pickup distance) — merged without re-alerting.
      if (incomingOfferRef.current?.estimatedEarnings == null) {
        void syncOfferFromServer();
      }

      router.push('/(app)/trip/incoming');

      apiClient
        ?.post(API.DRIVER_OFFER, { rideId: offerRideId, event: 'offer_displayed' })
        .catch(() => {});
    }

    // Always ensure the sound is running (restores it after a provider
    // remount stopped nothing — startOfferAlert is a no-op while this ride
    // is already alerting, so a spurious effect re-run does nothing).
    (async () => {
      const soundStarted = await startOfferAlert(offerRideId, expiresAt);
      if (soundStarted) {
        apiClient
          ?.post(API.DRIVER_OFFER, { rideId: offerRideId, event: 'alert_sound_started' })
          .catch(() => {});
      }
    })();

    const expiry = setTimeout(() => {
      apiClient
        ?.post(API.DRIVER_OFFER, { rideId: offerRideId, event: 'offer_expired_client' })
        .catch(() => {});
      setIncomingOfferState((current) => (current?.rideId === offerRideId ? null : current));
    }, Math.max(0, expiresAt - Date.now()));

    return () => {
      // Only the timer — never the alert itself; terminal paths (clear,
      // accept/decline, expiry, sign-out) stop it explicitly, and the
      // module-level auto-stop bounds it at the offer window regardless.
      clearTimeout(expiry);
    };
  }, [offerRideId, apiClient, syncOfferFromServer]);

  // An accepted/assigned trip supersedes any lingering offer card.
  useEffect(() => {
    if (state.activeTrip && incomingOffer?.rideId === state.activeTrip.id) {
      setIncomingOfferState(null);
    }
  }, [state.activeTrip, incomingOffer]);

  useEffect(() => {
    if (!user) {
      setIncomingOfferState(null);
      return;
    }
    void syncOfferFromServer();
    const interval = setInterval(() => void syncOfferFromServer(), 10_000);
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void syncOfferFromServer();
    });
    return () => {
      clearInterval(interval);
      sub.remove();
    };
  }, [user, syncOfferFromServer]);

  const value = useMemo(
    () => ({
      ...state,
      restoreActiveTrip,
      refreshTrip: restoreActiveTrip,
      markRoutePoint,
      clearTrip,
      apiClient,
      incomingOffer,
      setIncomingOffer,
    }),
    [state, restoreActiveTrip, markRoutePoint, clearTrip, apiClient, incomingOffer, setIncomingOffer],
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
