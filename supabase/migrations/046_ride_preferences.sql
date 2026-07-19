-- ═══════════════════════════════════════════════════════════════════════════
-- 046: Ride preferences — Women Preferred + Pet Friendly.
--
-- Config-driven (per-market rows with a NULL-state default), server-enforced.
-- Driver participation flags are service-role-only columns (040 pattern):
-- opt-in / invitation / enrollment state is never client-readable, and there
-- is intentionally NO gender column anywhere in the schema — Women Preferred
-- is an invitation + consent program, not an attribute lookup.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Preference configuration ------------------------------------------------
-- One active row per (preference, state_code); state_code NULL is the default
-- row a market falls back to. Fees are effective-date windowed so ops can
-- schedule changes without a deploy.

CREATE TABLE IF NOT EXISTS ride_preference_config (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  preference          TEXT NOT NULL CHECK (preference IN ('women_preferred', 'pet_friendly')),
  state_code          CHAR(2),                      -- NULL = default (all markets)
  enabled             BOOLEAN NOT NULL DEFAULT false,
  fee                 NUMERIC(10,2) CHECK (fee IS NULL OR fee >= 0),
  fee_effective_from  TIMESTAMPTZ,
  fee_effective_to    TIMESTAMPTZ,
  -- pet_friendly: { max_pets, size_guidance, eta_note }
  -- women_preferred: { rollout_note }
  rules               JSONB NOT NULL DEFAULT '{}',
  copy_version        TEXT,
  fallback_default    TEXT NOT NULL DEFAULT 'any_driver'
                        CHECK (fallback_default IN ('keep_looking', 'any_driver')),
  active              BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_ride_preference_config_updated
  BEFORE UPDATE ON ride_preference_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- One ACTIVE row per (preference, state_code) — including the NULL default.
CREATE UNIQUE INDEX one_active_preference_config
  ON ride_preference_config (preference, COALESCE(state_code::text, '~default~'))
  WHERE active;

-- Service-role only: the API decides what riders may see (visibility, copy,
-- fee). No client policies on purpose.
ALTER TABLE ride_preference_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ride_preference_config FROM authenticated, anon;

-- Seed default rows (NULL state = every market).
INSERT INTO ride_preference_config
  (preference, state_code, enabled, fee, rules, copy_version, fallback_default, active)
VALUES
  (
    'pet_friendly', NULL, true, 4.00,
    '{"max_pets": 1, "size_guidance": "One household pet in a carrier or on a blanket", "eta_note": "Fewer pet-friendly drivers may mean a slightly longer wait"}'::jsonb,
    'v1', 'any_driver', true
  ),
  (
    'women_preferred', NULL, true, NULL,
    '{"rollout_note": "Availability varies by market"}'::jsonb,
    'v1', 'any_driver', true
  );

-- 2. Driver participation flags ----------------------------------------------
-- pet_friendly_opt_in       — driver self-serve toggle (driver API only).
-- women_preferred_invited   — set by admins only; a driver can never self-invite.
-- women_preferred_enrolled  — driver consent, allowed only while invited.
-- women_preferred_enrolled_at — consent timestamp (audit trail).

ALTER TABLE drivers ADD COLUMN IF NOT EXISTS pet_friendly_opt_in       BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS women_preferred_enrolled  BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS women_preferred_invited   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS women_preferred_enrolled_at TIMESTAMPTZ;

-- 3. Column privacy (extends 040) ---------------------------------------------
-- Re-issue the column grant so the NEW columns are NOT in the client-readable
-- set. The list below is exactly the 040 public list — none of the preference
-- participation columns are granted; they are service-role only. Matching and
-- the driver/admin APIs read them with the service client.

REVOKE SELECT ON public.drivers FROM authenticated, anon;
GRANT SELECT (
  id, full_name, avatar_url, status, rating, total_trips,
  is_verified, is_active, created_at, updated_at, auth_user_id,
  accepts_pets, max_pet_size, pet_conditions
) ON public.drivers TO authenticated;
-- anon keeps no SELECT at all.

-- 4. Ride + quote preference snapshots ----------------------------------------
-- Server-validated shape (enforced in the API, not the DB):
--   {"women_preferred": bool, "pet_friendly": bool, "fallback": "keep_looking"|"any_driver"}
-- '{}' = no preferences (byte-identical legacy behavior).

ALTER TABLE rides       ADD COLUMN IF NOT EXISTS preferences JSONB NOT NULL DEFAULT '{}';
ALTER TABLE ride_quotes ADD COLUMN IF NOT EXISTS preferences JSONB NOT NULL DEFAULT '{}';

-- 5. Atomic multi-stop creation carries preferences ---------------------------
-- Same function as 042 with one addition: the validated preference snapshot
-- from p_ride lands on the ride row in the same transaction.

CREATE OR REPLACE FUNCTION public.create_ride_with_route_points(
  p_rider_id UUID,
  p_ride     JSONB,
  p_points   JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ride   rides%ROWTYPE;
  v_point  JSONB;
  v_count  INT;
BEGIN
  IF p_rider_id IS NULL THEN
    RAISE EXCEPTION 'rider_required';
  END IF;

  v_count := COALESCE(jsonb_array_length(p_points), 0);
  IF v_count < 2 OR v_count > 5 THEN
    RAISE EXCEPTION 'invalid_point_count';
  END IF;

  INSERT INTO rides (
    rider_id, quote_id, status,
    pickup_address, pickup_lat, pickup_lng,
    dropoff_address, dropoff_lat, dropoff_lng,
    vehicle_class, distance_km, duration_min, route_polyline,
    estimated_fare, currency, surge_multiplier, preferences, requested_at
  ) VALUES (
    p_rider_id,
    NULLIF(p_ride->>'quote_id', '')::uuid,
    'searching_driver',
    p_ride->>'pickup_address',
    (p_ride->>'pickup_lat')::numeric,
    (p_ride->>'pickup_lng')::numeric,
    p_ride->>'dropoff_address',
    (p_ride->>'dropoff_lat')::numeric,
    (p_ride->>'dropoff_lng')::numeric,
    (p_ride->>'vehicle_class')::vehicle_class,
    (p_ride->>'distance_km')::numeric,
    (p_ride->>'duration_min')::int,
    NULLIF(p_ride->>'route_polyline', ''),
    (p_ride->>'estimated_fare')::numeric,
    COALESCE(NULLIF(p_ride->>'currency', ''), 'USD'),
    COALESCE((p_ride->>'surge_multiplier')::numeric, 1.0),
    COALESCE(p_ride->'preferences', '{}'::jsonb),
    now()
  ) RETURNING * INTO v_ride;

  FOR v_point IN SELECT * FROM jsonb_array_elements(p_points) LOOP
    INSERT INTO ride_route_points (
      ride_id, point_type, seq, place_name, formatted_address,
      lat, lng, provider_place_id, leg_distance_km, leg_duration_min
    ) VALUES (
      v_ride.id,
      (v_point->>'point_type')::route_point_type,
      (v_point->>'seq')::int,
      NULLIF(v_point->>'place_name', ''),
      v_point->>'formatted_address',
      (v_point->>'lat')::numeric,
      (v_point->>'lng')::numeric,
      NULLIF(v_point->>'provider_place_id', ''),
      (v_point->>'leg_distance_km')::numeric,
      (v_point->>'leg_duration_min')::int
    );
  END LOOP;

  -- Deterministic-order integrity: with UNIQUE(ride_id, seq), seq bounds
  -- 0..count-1, pickup pinned at 0, and the dropoff pinned at the end, the
  -- sequence is provably contiguous with no duplicates.
  IF (SELECT min(seq) FROM ride_route_points WHERE ride_id = v_ride.id) <> 0
     OR (SELECT max(seq) FROM ride_route_points WHERE ride_id = v_ride.id) <> v_count - 1
     OR (SELECT seq FROM ride_route_points WHERE ride_id = v_ride.id AND point_type = 'dropoff') <> v_count - 1
  THEN
    RAISE EXCEPTION 'invalid_route_points';
  END IF;

  RETURN jsonb_build_object(
    'id', v_ride.id,
    'status', v_ride.status,
    'estimated_fare', v_ride.estimated_fare,
    'currency', v_ride.currency,
    'requested_at', v_ride.requested_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_ride_with_route_points(uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_ride_with_route_points(uuid, jsonb, jsonb) TO service_role;
