-- ═══════════════════════════════════════════════════════════════════════════
-- 055: find_nearby_drivers location freshness 60s → 90s
--
-- Live incident 2026-07-24 (ride 1b1d0413): an ONLINE driver at the pickup
-- point was invisible to matching. watchPositionAsync's timeInterval is
-- Android-only, so a stationary iPhone driver produced no position callbacks
-- and therefore no heartbeats; driver_locations.updated_at exceeded the 60s
-- window and every eligibility query returned zero rows.
--
-- The primary fix is client-side (a 20s stationary heartbeat timer in the
-- driver app). This widens the freshness window to 90s so ONE dropped
-- heartbeat request cannot make an online driver vanish; 90s of drift at
-- urban speeds (~600 m) stays well inside the smallest 3 km search radius.
-- Must stay in sync with LOCATION_FRESHNESS_SEC in lib/dispatch-diagnostics.ts.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION find_nearby_drivers(
  pickup_lat double precision,
  pickup_lng double precision,
  search_radius_m int DEFAULT 5000,
  ride_vehicle_class vehicle_class DEFAULT 'economy',
  max_results int DEFAULT 10
)
RETURNS TABLE (
  driver_id uuid,
  driver_name text,
  driver_rating numeric,
  vehicle_id uuid,
  vehicle_make text,
  vehicle_model text,
  vehicle_color text,
  plate_number text,
  distance_m double precision,
  heading numeric,
  lat double precision,
  lng double precision
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT
    d.id AS driver_id,
    d.full_name AS driver_name,
    d.rating AS driver_rating,
    v.id AS vehicle_id,
    v.make AS vehicle_make,
    v.model AS vehicle_model,
    v.color AS vehicle_color,
    v.plate_number,
    ST_Distance(
      dl.location::geography,
      ST_SetSRID(ST_MakePoint(pickup_lng, pickup_lat), 4326)::geography
    ) AS distance_m,
    dl.heading,
    ST_Y(dl.location::geometry) AS lat,
    ST_X(dl.location::geometry) AS lng
  FROM drivers d
  JOIN vehicles v ON v.driver_id = d.id
  JOIN driver_locations dl ON dl.driver_id = d.id
  WHERE d.status = 'available'
    AND d.is_verified = true
    AND d.is_active = true
    AND v.is_active = true
    AND v.vehicle_class = ride_vehicle_class
    AND dl.updated_at > now() - interval '90 seconds'  -- was 60s; see header
    AND ST_DWithin(
      dl.location::geography,
      ST_SetSRID(ST_MakePoint(pickup_lng, pickup_lat), 4326)::geography,
      search_radius_m
    )
  ORDER BY distance_m ASC
  LIMIT max_results;
$$;
