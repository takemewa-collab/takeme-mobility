-- ═══════════════════════════════════════════════════════════════════════════
-- 054 — GPS accuracy on driver locations.
--
-- Trip gating (arrived-at-pickup, complete-at-destination) validates the
-- driver's latest server-known fix; a fix with terrible reported accuracy
-- must not pass a 100m geofence. The heartbeat now records the device's
-- horizontal accuracy (meters) when available.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE driver_locations ADD COLUMN IF NOT EXISTS accuracy_m NUMERIC;

-- Recreate with an added defaulted parameter. The old 5-arg signature must be
-- dropped first — otherwise both overloads exist and 5-arg calls are
-- ambiguous. Old clients keep working: their 5-arg calls resolve to the new
-- function with p_accuracy_m defaulting to NULL.
DROP FUNCTION IF EXISTS upsert_driver_location(uuid, double precision, double precision, numeric, numeric);

CREATE OR REPLACE FUNCTION upsert_driver_location(
  p_driver_id uuid,
  p_lat double precision,
  p_lng double precision,
  p_heading numeric DEFAULT NULL,
  p_speed_kmh numeric DEFAULT NULL,
  p_accuracy_m numeric DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO driver_locations (driver_id, location, heading, speed_kmh, accuracy_m, updated_at)
  VALUES (
    p_driver_id,
    ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography,
    p_heading,
    p_speed_kmh,
    p_accuracy_m,
    now()
  )
  ON CONFLICT (driver_id) DO UPDATE SET
    location = ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography,
    heading = COALESCE(p_heading, driver_locations.heading),
    speed_kmh = COALESCE(p_speed_kmh, driver_locations.speed_kmh),
    accuracy_m = p_accuracy_m,
    updated_at = now();
END;
$$;

REVOKE EXECUTE ON FUNCTION upsert_driver_location(uuid, double precision, double precision, numeric, numeric, numeric) FROM anon, authenticated;
