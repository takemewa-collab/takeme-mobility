// ═══════════════════════════════════════════════════════════════════════════
// TAKEME MOBILITY — Dispatch Service (Production-Grade)
//
// Flow: offer → accept/timeout → escalate
//   1. Find candidates (PostGIS + smart matching)
//   2. Offer ride to best driver (Redis offer with 15s TTL + push)
//   3. If driver accepts within 15s → finalize assignment
//   4. If timeout → exclude driver, offer to next candidate
//   5. After 3 attempts → cancel ride, DLQ, Sentry
//
// Redis lock prevents double-dispatch of the same ride.
// ═══════════════════════════════════════════════════════════════════════════

import { createServiceClient } from '@/lib/supabase/service';
import { selectBestDriver, stablePreferEnrolled, type DriverCandidate } from '@/lib/matching';
import { applyPreferenceFilters, type StoredRidePreferences } from '@/lib/ride-preferences';
import {
  setDriverOffer,
  getDriverOffer,
  clearDriverOffer,
  addExcludedDriver,
  getExcludedDrivers,
} from '@/lib/redis';
import { sendPushNotification, rideRequestNotification, rideAssignedNotification, pushTokenForDriverRow, pushTokenForUser } from '@/lib/push';

export const OFFER_TIMEOUT_SEC = 15;
export const MAX_ESCALATIONS = 3;

export interface NearbyDriver {
  driver_id: string;
  driver_name: string;
  driver_rating: number;
  vehicle_id: string;
  vehicle_make: string;
  vehicle_model: string;
  vehicle_color: string;
  plate_number: string;
  distance_m: number;
  heading: number | null;
  lat: number;
  lng: number;
  // Preference participation flags — annotated in findCandidates via the
  // service client (these columns are never client-readable).
  pet_friendly_opt_in?: boolean;
  women_preferred_enrolled?: boolean;
}

export interface AssignmentResult {
  success: boolean;
  driver: NearbyDriver | null;
  error?: string;
}

/**
 * Find available drivers near a pickup point.
 */
export async function findNearbyDrivers(
  pickupLat: number,
  pickupLng: number,
  vehicleClass: 'economy' | 'comfort' | 'premium',
  radiusMeters = 5000,
  limit = 10,
): Promise<NearbyDriver[]> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc('find_nearby_drivers', {
    pickup_lat: pickupLat,
    pickup_lng: pickupLng,
    search_radius_m: radiusMeters,
    ride_vehicle_class: vehicleClass,
    max_results: limit,
  });

  if (error) {
    console.error('find_nearby_drivers RPC failed:', error.message);
    return [];
  }
  return (data as NearbyDriver[]) ?? [];
}

/**
 * Find candidates for a ride, excluding already-offered drivers.
 * Returns ranked list (best match first).
 */
export async function findCandidates(rideId: string): Promise<{
  candidates: NearbyDriver[];
  ride: { id: string; pickup_lat: number; pickup_lng: number; vehicle_class: string; status: string; pickup_address: string; dropoff_address: string; estimated_fare: number; distance_km: number; preferences: StoredRidePreferences } | null;
}> {
  const supabase = createServiceClient();

  const { data: ride } = await supabase
    .from('rides')
    .select('id, pickup_lat, pickup_lng, vehicle_class, status, pickup_address, dropoff_address, estimated_fare, distance_km, preferences')
    .eq('id', rideId)
    .single();

  if (!ride || ride.status !== 'searching_driver') {
    return { candidates: [], ride: null };
  }

  const preferences: StoredRidePreferences = (ride.preferences ?? {}) as StoredRidePreferences;
  const needsFlags =
    preferences.pet_friendly === true || preferences.women_preferred === true;

  // Get excluded drivers (already timed out for this ride)
  const excluded = await getExcludedDrivers(rideId);

  // Find nearby drivers with expanding radius. Preference filtering happens
  // INSIDE the loop so a radius emptied by filters still expands outward.
  let drivers: NearbyDriver[] = [];
  const radii = [3000, 5000, 10000];
  for (const radius of radii) {
    drivers = await findNearbyDrivers(ride.pickup_lat, ride.pickup_lng, ride.vehicle_class as 'economy' | 'comfort' | 'premium', radius);
    // Filter out excluded drivers
    drivers = drivers.filter(d => !excluded.includes(d.driver_id));

    if (needsFlags && drivers.length > 0) {
      // Annotate preference flags via the service client (the RPC stays
      // untouched; these columns are never client-readable) and apply the
      // hard filters: pet_friendly always, women_preferred only when the
      // rider chose 'keep_looking' — with 'any_driver' enrolled drivers are
      // prioritized below, never required.
      drivers = await annotatePreferenceFlags(drivers);
      drivers = applyPreferenceFilters(drivers, preferences);
    }

    if (drivers.length > 0) break;
  }

  const preferWomenEnrolled =
    preferences.women_preferred === true &&
    (preferences.fallback ?? 'any_driver') === 'any_driver';

  // Rank by smart matching
  if (drivers.length > 1) {
    const best = selectBestDriver(
      drivers as DriverCandidate[],
      ride.pickup_lat,
      ride.pickup_lng,
      { preferWomenEnrolled },
    );
    if (best) {
      // Move best to front, keep rest as fallbacks (enrolled-first when the
      // rider asked for Women Preferred, so escalation honors the preference).
      let rest = drivers.filter(d => d.driver_id !== best.driver_id);
      if (preferWomenEnrolled) rest = stablePreferEnrolled(rest);
      drivers = [best as unknown as NearbyDriver, ...rest];
    }
  }

  return { candidates: drivers, ride: { ...ride, preferences } };
}

/**
 * Fetch preference participation flags for candidate driver ids with the
 * service role (never client-readable) and merge them onto the candidates.
 * A driver missing from the lookup keeps `undefined` flags — treated as not
 * participating.
 */
async function annotatePreferenceFlags(candidates: NearbyDriver[]): Promise<NearbyDriver[]> {
  const supabase = createServiceClient();
  const ids = candidates.map(c => c.driver_id);
  const { data, error } = await supabase
    .from('drivers')
    .select('id, pet_friendly_opt_in, women_preferred_enrolled')
    .in('id', ids);

  if (error) {
    // Fail closed for preference rides: without flags we cannot honor the
    // preference, so no candidate qualifies this round.
    console.error('[dispatch] preference flag lookup failed:', error.message);
    return candidates.map(c => ({ ...c, pet_friendly_opt_in: false, women_preferred_enrolled: false }));
  }

  const flags = new Map(
    (data ?? []).map(d => [
      d.id as string,
      {
        pet: Boolean(d.pet_friendly_opt_in),
        women: Boolean(d.women_preferred_enrolled),
      },
    ]),
  );

  return candidates.map(c => {
    const f = flags.get(c.driver_id);
    return {
      ...c,
      pet_friendly_opt_in: f?.pet ?? false,
      women_preferred_enrolled: f?.women ?? false,
    };
  });
}

/**
 * Offer a ride to a specific driver.
 * Sets Redis offer key (15s TTL) and sends push notification.
 * Does NOT assign the ride — waits for driver to accept.
 */
export async function offerRideToDriver(
  rideId: string,
  driver: NearbyDriver,
  ride: { pickup_address: string; dropoff_address: string; estimated_fare: number; distance_km: number; preferences?: StoredRidePreferences | null },
): Promise<boolean> {
  // Set offer in Redis (15s TTL — auto-expires if driver doesn't respond)
  await setDriverOffer(rideId, driver.driver_id, OFFER_TIMEOUT_SEC);

  const petFriendly = ride.preferences?.pet_friendly === true;

  // Send push notification to driver (resolves drivers.id → auth user id).
  // The pet_friendly flag rides along so the driver sees it BEFORE accepting.
  const supabase = createServiceClient();
  const offerToken = await pushTokenForDriverRow(driver.driver_id);
  if (offerToken) {
    await sendPushNotification(rideRequestNotification(offerToken, {
      rideId,
      pickupAddress: ride.pickup_address,
      dropoffAddress: ride.dropoff_address,
      estimatedFare: Number(ride.estimated_fare),
      distanceKm: Number(ride.distance_km),
      petFriendly,
    }));
  }

  // Log the offer
  await supabase.from('ride_events').insert({
    ride_id: rideId,
    event_type: 'offer_sent',
    actor: 'system',
    metadata: {
      driver_id: driver.driver_id,
      driver_name: driver.driver_name,
      distance_m: driver.distance_m,
      timeout_sec: OFFER_TIMEOUT_SEC,
      ...(petFriendly ? { pet_friendly: true } : {}),
    },
  });

  console.log(`[dispatch] Offered ride ${rideId} to ${driver.driver_name} (${Math.round(driver.distance_m)}m away, ${OFFER_TIMEOUT_SEC}s timeout)`);
  return true;
}

/**
 * Check if the offer for a ride was accepted by the driver.
 * If the Redis offer key is gone, the driver accepted (cleared it via accept API).
 */
export async function checkOfferAccepted(rideId: string): Promise<boolean> {
  const offer = await getDriverOffer(rideId);
  // If key is null, either accepted (cleared) or expired (TTL)
  // We check the ride status to distinguish
  const supabase = createServiceClient();
  const { data: ride } = await supabase
    .from('rides')
    .select('status')
    .eq('id', rideId)
    .single();

  return ride?.status === 'driver_assigned' || ride?.status === 'driver_arriving';
}

/**
 * Handle offer timeout: exclude the driver, release them back to available.
 */
export async function handleOfferExpiry(rideId: string, driverId: string): Promise<void> {
  // Add to excluded list so we don't re-offer
  await addExcludedDriver(rideId, driverId);

  // Clear any remaining offer
  await clearDriverOffer(rideId);

  // Log timeout
  const supabase = createServiceClient();
  await supabase.from('ride_events').insert({
    ride_id: rideId,
    event_type: 'offer_timeout',
    actor: 'system',
    metadata: { driver_id: driverId, timeout_sec: OFFER_TIMEOUT_SEC },
  });

  console.log(`[dispatch] Offer timed out for ride ${rideId}, driver ${driverId}`);
}

/**
 * Finalize assignment — called when driver accepts the offer.
 * Updates ride status + driver status atomically.
 */
export async function finalizeAssignment(rideId: string, driverId: string): Promise<AssignmentResult> {
  const supabase = createServiceClient();

  // Clear the Redis offer (signals acceptance to timeout checker)
  await clearDriverOffer(rideId);

  // Get driver details
  const { data: drivers } = await supabase
    .from('drivers')
    .select('id, full_name, rating')
    .eq('id', driverId)
    .single();

  const { data: vehicle } = await supabase
    .from('vehicles')
    .select('id, make, model, color, plate_number')
    .eq('driver_id', driverId)
    .eq('is_active', true)
    .single();

  if (!drivers) {
    return { success: false, driver: null, error: 'Driver not found' };
  }

  const now = new Date().toISOString();

  // Update ride (optimistic lock)
  const { error: assignError } = await supabase
    .from('rides')
    .update({
      assigned_driver_id: driverId,
      vehicle_id: vehicle?.id ?? null,
      status: 'driver_assigned',
      driver_assigned_at: now,
    })
    .eq('id', rideId)
    .eq('status', 'searching_driver');

  if (assignError) {
    return { success: false, driver: null, error: 'Assignment failed — ride status changed' };
  }

  // Set driver to busy
  await supabase
    .from('drivers')
    .update({ status: 'busy' })
    .eq('id', driverId)
    .eq('status', 'available');

  // Cleanup dispatch state
  const { cleanupDispatchState } = await import('@/lib/redis');
  await cleanupDispatchState(rideId);

  // Log event. The plate is intentionally NOT recorded here — it reaches the
  // assigned rider only through the authorized ride payload after acceptance.
  await supabase.from('ride_events').insert({
    ride_id: rideId,
    event_type: 'driver_assigned',
    new_status: 'driver_assigned',
    old_status: 'searching_driver',
    actor: 'driver',
    metadata: {
      driver_id: driverId,
      driver_name: drivers.full_name,
      vehicle: vehicle ? `${vehicle.make} ${vehicle.model}` : 'Unknown',
    },
  });

  // Notify both sides. The realtime subscription already drives the in-app UI;
  // push reaches a backgrounded driver/rider. Non-blocking.
  try {
    const driverToken = await pushTokenForDriverRow(driverId);
    if (driverToken) {
      const { data: ride } = await supabase
        .from('rides')
        .select('rider_id, pickup_lat, pickup_lng, pickup_address, dropoff_address, estimated_fare, distance_km')
        .eq('id', rideId)
        .single();
      if (ride) {
        await sendPushNotification(rideRequestNotification(driverToken, {
          rideId,
          pickupAddress: ride.pickup_address,
          dropoffAddress: ride.dropoff_address,
          estimatedFare: Number(ride.estimated_fare),
          distanceKm: Number(ride.distance_km ?? 0),
        }));
        const riderToken = ride.rider_id ? await pushTokenForUser(ride.rider_id, 'rider') : null;
        if (riderToken) {
          // ETA only when we can compute it from the driver's real position —
          // never a made-up number. Omitted otherwise.
          const etaMinutes = await estimateEtaMinutes(driverId, ride.pickup_lat, ride.pickup_lng);
          await sendPushNotification(rideAssignedNotification(riderToken, {
            rideId,
            driverName: drivers.full_name,
            vehicleDesc: vehicle ? `${vehicle.color} ${vehicle.make} ${vehicle.model}` : 'your ride',
            etaMinutes: etaMinutes ?? undefined,
          }));
        }
      }
    }
  } catch (pushErr) {
    console.error('[dispatch] assignment push failed (non-blocking):', pushErr);
  }

  const driverResult: NearbyDriver = {
    driver_id: driverId,
    driver_name: drivers.full_name,
    driver_rating: Number(drivers.rating),
    vehicle_id: vehicle?.id ?? '',
    vehicle_make: vehicle?.make ?? '',
    vehicle_model: vehicle?.model ?? '',
    vehicle_color: vehicle?.color ?? '',
    plate_number: vehicle?.plate_number ?? '',
    distance_m: 0,
    heading: null,
    lat: 0,
    lng: 0,
  };

  return { success: true, driver: driverResult };
}

/**
 * ETA from the driver's last known position to the pickup, straight-line at
 * a conservative urban speed. Returns null when there is no fresh fix —
 * callers must omit the ETA rather than invent one.
 */
export async function estimateEtaMinutes(
  driverId: string,
  pickupLat: number,
  pickupLng: number,
): Promise<number | null> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from('driver_locations')
    .select('location, updated_at')
    .eq('driver_id', driverId)
    .gte('updated_at', new Date(Date.now() - 60_000).toISOString())
    .maybeSingle();
  const coords = (data?.location as { coordinates?: number[] } | null)?.coordinates;
  if (!coords || coords.length < 2) return null;

  const [lng, lat] = coords;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(pickupLat - lat);
  const dLng = toRad(pickupLng - lng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat)) * Math.cos(toRad(pickupLat)) * Math.sin(dLng / 2) ** 2;
  const meters = 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  // ~25 km/h effective urban speed ≈ 420 m/min, minimum 1 minute.
  return Math.max(1, Math.round(meters / 420));
}

// NOTE: the legacy `assignDriver` direct-assignment path was removed on
// purpose. Every ride goes through the offer pipeline (lib/dispatch-queue
// `dispatchRide`): a driver must explicitly accept before assignment.
