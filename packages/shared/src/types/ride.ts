import type { LocationWithAddress } from './location';

export type RideStatus =
  | 'pending'
  | 'quoted'
  | 'searching_driver'
  | 'driver_assigned'
  | 'driver_arriving'
  | 'arrived'
  | 'in_progress'
  | 'completed'
  | 'cancelled';

export type VehicleClass =
  | 'electric'
  | 'comfort_electric'
  | 'premium_electric'
  | 'suv_electric'
  | 'women_rider'
  | 'pet_ride';

export type CancelledBy = 'rider' | 'driver' | 'system';

export type RoutePointType = 'pickup' | 'stop' | 'dropoff';

export type RoutePointStatus = 'pending' | 'arrived' | 'completed' | 'skipped';

/**
 * One point of a multi-stop itinerary (ride_route_points row), ordered by
 * `seq` (0 = pickup … n-1 = dropoff). Single-destination rides have none —
 * clients fall back to the flat pickup/dropoff columns on the ride.
 */
export interface RoutePoint {
  id: string;
  point_type: RoutePointType;
  seq: number;
  place_name: string | null;
  formatted_address: string;
  lat: number;
  lng: number;
  /** The leg ARRIVING at this point (null for pickup and when unknown). */
  leg_distance_km: number | null;
  leg_duration_min: number | null;
  status: RoutePointStatus;
  arrived_at: string | null;
  completed_at: string | null;
}

export type AirportContextDirection = 'airport_pickup' | 'airport_dropoff';

/** One ordered instruction shown to the driver at the airport. */
export interface AirportInstruction {
  title: string;
  body: string;
}

/**
 * Immutable copy of the airport configuration taken when the ride was booked
 * (trip_airport_context.snapshot). Clients render this snapshot, never live
 * airport config — it cannot change under an in-flight trip.
 */
export interface AirportContextSnapshot {
  airport: {
    id: string;
    iata_code: string;
    display_name: string;
  };
  direction: AirportContextDirection;
  airline?: {
    display_name: string;
    iata_code: string;
  };
  terminal?: {
    code: string;
    name: string;
  };
  service_point: {
    id: string;
    point_type: string;
    name: string;
    lat: number;
    lng: number;
    level: string | null;
    door: string | null;
    zone: string | null;
    island: string | null;
  };
  instructions: {
    driver: AirportInstruction[];
  };
  /** Airport access fee snapshot; shape is server-owned and not rendered here. */
  fee?: unknown;
  flight_number?: string;
}

/**
 * Airport context attached to a ride (trip_airport_context row). Anchored to a
 * specific stop via `route_point_id`, or to the ride-level pickup/dropoff when
 * null.
 */
export interface AirportContext {
  id: string;
  direction: AirportContextDirection;
  route_point_id: string | null;
  flight_number: string | null;
  selection_method: string;
  snapshot: AirportContextSnapshot;
}

export type RideEventType =
  | 'status_change'
  | 'location_update'
  | 'fare_adjusted'
  | 'driver_assigned'
  | 'driver_unassigned'
  | 'payment_authorized'
  | 'payment_captured'
  | 'cancellation';

export interface Ride {
  id: string;
  rider_id: string;
  assigned_driver_id: string | null;
  vehicle_id: string | null;
  quote_id: string | null;
  status: RideStatus;
  vehicle_class: VehicleClass;

  pickup_lat: number;
  pickup_lng: number;
  pickup_address: string;
  dropoff_lat: number;
  dropoff_lng: number;
  dropoff_address: string;

  distance_km: number | null;
  duration_min: number | null;
  estimated_fare: number | null;
  final_fare: number | null;
  surge_multiplier: number;

  requested_at: string;
  driver_assigned_at: string | null;
  driver_arrived_at: string | null;
  trip_started_at: string | null;
  trip_completed_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  cancelled_by: CancelledBy | null;

  rider_rating: number | null;
  driver_rating: number | null;

  /**
   * Ordered multi-stop itinerary, present when the server (or a client-side
   * fetch) attaches it. Empty/absent for single-destination rides.
   */
  route_points?: RoutePoint[];

  /**
   * Airport contexts for any airport legs of the trip, present when the server
   * attaches them. Empty/absent for rides that never touch an airport.
   */
  airport_contexts?: AirportContext[];
}

export interface RideEvent {
  id: string;
  ride_id: string;
  event_type: RideEventType;
  old_status: RideStatus | null;
  new_status: RideStatus | null;
  actor: 'rider' | 'driver' | 'system';
  metadata: Record<string, unknown>;
  created_at: string;
}

/** The pickup/dropoff pair the rider selects before requesting quotes */
export interface RideRequest {
  pickup: LocationWithAddress;
  dropoff: LocationWithAddress;
  vehicle_class: VehicleClass;
  surge_multiplier?: number;
}

/** States where the ride is "active" from the rider's perspective */
export const ACTIVE_RIDE_STATUSES: RideStatus[] = [
  'searching_driver',
  'driver_assigned',
  'driver_arriving',
  'arrived',
  'in_progress',
];

/** States from which a rider can cancel */
export const RIDER_CANCELLABLE_STATUSES: RideStatus[] = [
  'pending',
  'quoted',
  'searching_driver',
  'driver_assigned',
  'driver_arriving',
  'arrived',
];
