-- ═══════════════════════════════════════════════════════════════════════════
-- 045: Restrict coordinate-based airport resolution to passenger-relevant
-- facilities.
--
-- The national NASR catalog contains ~19k landing facilities, including
-- thousands of heliports, private strips and seaplane bases whose detection
-- radii blanket city centers (downtown Seattle sits inside several heliport
-- radii). Live E2E showed a downtown address resolving as an "airport".
-- Geospatial detection must only ever identify facilities a rider could
-- plausibly be traveling to as a passenger: public airports with recognized
-- commercial service, or facilities TAKEME has explicitly promoted into
-- coverage. Identifier-based resolution (IATA/ICAO/provider id/alias) is
-- unaffected — it is already explicit.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.resolve_airport_by_point(
  p_lat DOUBLE PRECISION,
  p_lng DOUBLE PRECISION
) RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id FROM airports
  WHERE active
    AND catalog_status = 'active'
    AND airport_type = 'airport'
    AND NOT private_use
    AND NOT military_only
    AND (
      service_class IN ('large_hub','medium_hub','small_hub','nonhub_primary','nonprimary_commercial')
      OR coverage_status IN ('serviceable','curated','verified','temporarily_disabled')
    )
    AND (
      (geofence IS NOT NULL AND ST_Covers(geofence, ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography))
      OR ST_DWithin(location, ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography, detection_radius_m)
    )
  ORDER BY
    (geofence IS NOT NULL AND ST_Covers(geofence, ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography)) DESC,
    ST_Distance(location, ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography) ASC
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.resolve_airport_by_point(double precision, double precision) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_airport_by_point(double precision, double precision) TO service_role;
