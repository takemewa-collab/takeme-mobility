-- ═══════════════════════════════════════════════════════════════════════════
-- 042: Multi-stop rides — normalized, ordered route points per ride.
--
-- A ride's itinerary is pickup → up to 3 intermediate stops → dropoff. The
-- rides table keeps its flat pickup_*/dropoff_* columns (pickup + FINAL
-- destination) so every existing reader keeps working; this table is the
-- ordered source of truth for the full route. Single-destination rides may
-- simply have no rows here — readers must treat "no points" as the classic
-- two-point trip.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Types ------------------------------------------------------------------

CREATE TYPE route_point_type AS ENUM ('pickup', 'stop', 'dropoff');
CREATE TYPE route_point_status AS ENUM ('pending', 'arrived', 'completed', 'skipped');

-- 2. Table ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ride_route_points (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id            UUID NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  point_type         route_point_type NOT NULL,
  -- 0 = pickup … n-1 = dropoff. Max 5 points total (pickup + 3 stops + dropoff).
  seq                INTEGER NOT NULL CHECK (seq >= 0 AND seq <= 4),
  place_name         TEXT,
  formatted_address  TEXT NOT NULL CHECK (char_length(formatted_address) BETWEEN 1 AND 500),
  lat                NUMERIC(10,7) NOT NULL CHECK (lat >= -90 AND lat <= 90),
  lng                NUMERIC(10,7) NOT NULL CHECK (lng >= -180 AND lng <= 180),
  provider_place_id  TEXT,
  -- The leg ARRIVING at this point (null for pickup and when unknown).
  leg_distance_km    NUMERIC(8,2) CHECK (leg_distance_km IS NULL OR leg_distance_km >= 0),
  leg_duration_min   INTEGER CHECK (leg_duration_min IS NULL OR leg_duration_min >= 0),
  status             route_point_status NOT NULL DEFAULT 'pending',
  arrived_at         TIMESTAMPTZ,
  completed_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ride_id, seq)
);

-- Exactly one pickup and one dropoff per ride; pickup always opens the route.
CREATE UNIQUE INDEX one_pickup_per_ride  ON ride_route_points(ride_id) WHERE point_type = 'pickup';
CREATE UNIQUE INDEX one_dropoff_per_ride ON ride_route_points(ride_id) WHERE point_type = 'dropoff';
ALTER TABLE ride_route_points
  ADD CONSTRAINT pickup_is_first CHECK (point_type <> 'pickup' OR seq = 0);

CREATE INDEX idx_rrp_ride_seq ON ride_route_points(ride_id, seq);

CREATE TRIGGER trg_ride_route_points_updated
  BEFORE UPDATE ON ride_route_points
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- 3. RLS --------------------------------------------------------------------
-- Reads follow the ride_messages participant model (039): the rider who owns
-- the ride and the assigned driver. All writes go through the API with the
-- service role (or the SECURITY DEFINER creator below) — no client write
-- policies on purpose.

ALTER TABLE ride_route_points ENABLE ROW LEVEL SECURITY;

CREATE POLICY rrp_select_rider ON ride_route_points
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM rides r
      WHERE r.id = ride_route_points.ride_id
        AND r.rider_id = (SELECT public.app_user_id())
    )
  );

CREATE POLICY rrp_select_driver ON ride_route_points
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM rides r
      WHERE r.id = ride_route_points.ride_id
        AND r.assigned_driver_id = public.get_driver_id()
    )
  );

-- 4. Realtime ---------------------------------------------------------------
-- Rider and driver apps subscribe to point status changes (arrived/completed/
-- skipped) so both stay in sync during a multi-stop trip.

ALTER PUBLICATION supabase_realtime ADD TABLE public.ride_route_points;

-- 5. Atomic creation --------------------------------------------------------
-- The ride row and its ordered points must land in one transaction: a ride
-- with half a route is worse than no ride. Service-role only — the API route
-- authenticates the rider, validates the route server-side, and passes the
-- resolved rider id explicitly.

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
    estimated_fare, currency, surge_multiplier, requested_at
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
