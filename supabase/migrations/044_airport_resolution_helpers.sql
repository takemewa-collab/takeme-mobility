-- ═══════════════════════════════════════════════════════════════════════════
-- 044: Airport resolution & publish helpers
--
-- SQL-side helpers for the Airport Intelligence Platform (043):
--   * normalize_airport_name  — canonical alias normalization, shared by
--                               importers and the API's controlled name
--                               fallback (exact-match only, never heuristics).
--   * resolve_airport_by_point — PostGIS containment/proximity resolution.
--     supabase-js cannot call ST_* directly; this wraps the geofence/radius
--     logic in one indexed query. Geofence containment always outranks a
--     radius match, then nearest wins.
--   * publish_airport_config  — atomic publish: verify listed child rows and
--     (optionally) promote coverage_status in ONE transaction, since
--     supabase-js has no client-side transactions. The 043 triggers
--     (verified floor, assignment integrity) keep enforcing invariants.
--
-- All functions are SECURITY DEFINER with service_role-only EXECUTE: the
-- catalog is never readable or writable by clients directly.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Name normalization -------------------------------------------------------
-- lower, collapse every non-alphanumeric run to a single space, trim.
-- Mirrors airports.normalized_name so alias lookups are exact-match.

CREATE OR REPLACE FUNCTION public.normalize_airport_name(p_name TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $$
  SELECT NULLIF(btrim(regexp_replace(lower(COALESCE(p_name, '')), '[^a-z0-9]+', ' ', 'g')), '');
$$;

REVOKE ALL ON FUNCTION public.normalize_airport_name(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.normalize_airport_name(text) TO service_role;

-- 2. Point → airport resolution -----------------------------------------------
-- Active catalog rows only. A point inside a curated geofence beats any
-- radius-only match; among radius matches the nearest airport wins. Both the
-- GIST indexes from 043 (idx_airports_geofence, idx_airports_location) serve
-- this query. LIMIT 1 keeps it bounded.

CREATE OR REPLACE FUNCTION public.resolve_airport_by_point(
  p_lat DOUBLE PRECISION,
  p_lng DOUBLE PRECISION
)
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH pt AS (
    SELECT ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography AS g
  )
  SELECT a.id
  FROM airports a
  CROSS JOIN pt
  WHERE a.active
    AND a.catalog_status = 'active'
    AND (
      (a.geofence IS NOT NULL AND ST_Covers(a.geofence, pt.g))
      OR ST_DWithin(a.location, pt.g, a.detection_radius_m)
    )
  ORDER BY
    (a.geofence IS NOT NULL AND ST_Covers(a.geofence, pt.g)) DESC,
    ST_Distance(a.location, pt.g) ASC
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.resolve_airport_by_point(double precision, double precision) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_airport_by_point(double precision, double precision) TO service_role;

-- 3. Atomic publish ------------------------------------------------------------
-- Marks the explicitly listed terminals / service points / assignments
-- verified and optionally moves coverage_status — all inside one transaction.
-- Every listed id must belong to the airport (raises rather than silently
-- skipping), and only ACTIVE rows can be verified: verifying a deactivated
-- curb would resurrect it into the operational floor check. The 043 trigger
-- trg_airports_verified_floor still blocks promoting to 'verified' without an
-- active verified general drop-off + rideshare pickup.

CREATE OR REPLACE FUNCTION public.publish_airport_config(
  p_airport        UUID,
  p_terminals      UUID[] DEFAULT '{}',
  p_service_points UUID[] DEFAULT '{}',
  p_assignments    UUID[] DEFAULT '{}',
  p_coverage       TEXT   DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminals      INT := 0;
  v_points         INT := 0;
  v_assignments    INT := 0;
  v_coverage       airport_coverage_status;
  v_final_coverage airport_coverage_status;
BEGIN
  -- Lock the airport row so concurrent publishes serialize.
  PERFORM 1 FROM airports WHERE id = p_airport FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'airport_not_found';
  END IF;

  -- Ownership guards: every listed id must be an ACTIVE child of THIS airport.
  IF EXISTS (
    SELECT 1 FROM unnest(COALESCE(p_terminals, '{}')) AS t(id)
    LEFT JOIN airport_terminals x ON x.id = t.id AND x.airport_id = p_airport AND x.active
    WHERE x.id IS NULL
  ) THEN
    RAISE EXCEPTION 'publish_terminal_invalid';
  END IF;

  IF EXISTS (
    SELECT 1 FROM unnest(COALESCE(p_service_points, '{}')) AS t(id)
    LEFT JOIN airport_service_points x ON x.id = t.id AND x.airport_id = p_airport AND x.active
    WHERE x.id IS NULL
  ) THEN
    RAISE EXCEPTION 'publish_service_point_invalid';
  END IF;

  IF EXISTS (
    SELECT 1 FROM unnest(COALESCE(p_assignments, '{}')) AS t(id)
    LEFT JOIN airport_airline_assignments x ON x.id = t.id AND x.airport_id = p_airport AND x.active
    WHERE x.id IS NULL
  ) THEN
    RAISE EXCEPTION 'publish_assignment_invalid';
  END IF;

  UPDATE airport_terminals
    SET verified = true
    WHERE id = ANY(COALESCE(p_terminals, '{}')) AND airport_id = p_airport AND NOT verified;
  GET DIAGNOSTICS v_terminals = ROW_COUNT;

  UPDATE airport_service_points
    SET verified = true
    WHERE id = ANY(COALESCE(p_service_points, '{}')) AND airport_id = p_airport AND NOT verified;
  GET DIAGNOSTICS v_points = ROW_COUNT;

  UPDATE airport_airline_assignments
    SET verified = true
    WHERE id = ANY(COALESCE(p_assignments, '{}')) AND airport_id = p_airport AND NOT verified;
  GET DIAGNOSTICS v_assignments = ROW_COUNT;

  IF p_coverage IS NOT NULL THEN
    v_coverage := p_coverage::airport_coverage_status; -- raises on invalid value
    UPDATE airports SET coverage_status = v_coverage WHERE id = p_airport;
  END IF;

  SELECT coverage_status INTO v_final_coverage FROM airports WHERE id = p_airport;

  RETURN jsonb_build_object(
    'airport_id', p_airport,
    'terminals_verified', v_terminals,
    'service_points_verified', v_points,
    'assignments_verified', v_assignments,
    'coverage_status', v_final_coverage
  );
END;
$$;

REVOKE ALL ON FUNCTION public.publish_airport_config(uuid, uuid[], uuid[], uuid[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_airport_config(uuid, uuid[], uuid[], uuid[], text) TO service_role;

-- 4. Helper index --------------------------------------------------------------
-- Alias/identifier lookups filter by (identifier_type, identifier_value)
-- through the partial-unique index from 043; airport-scoped listings use
-- idx_airport_identifiers_airport. The admin catalog search filters
-- upper-cased IATA/FAA codes — both already plain b-tree-indexed via the
-- partial uniques. One addition: revisions are queried per airport via the
-- jsonb payload, so index the extracted airport id.

CREATE INDEX IF NOT EXISTS idx_adr_after_airport
  ON airport_data_revisions ((after ->> 'airport_id'));
