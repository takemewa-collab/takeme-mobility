-- ═══════════════════════════════════════════════════════════════════════════
-- Scalability fixes: atomic transfers, webhook dedup, stale location filter
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Atomic card funding transfer ─────────────────────────────────────────
-- Prevents race condition where concurrent requests could overdraw balance
CREATE OR REPLACE FUNCTION transfer_to_card(p_driver_id uuid, p_amount numeric)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_available numeric;
  v_card_balance numeric;
BEGIN
  -- Lock the row to prevent concurrent updates
  SELECT available, card_balance INTO v_available, v_card_balance
  FROM driver_balances
  WHERE driver_id = p_driver_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'No balance record found.');
  END IF;

  IF v_available < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error',
      format('Insufficient balance. Available: $%s', to_char(v_available, 'FM999999990.00')));
  END IF;

  UPDATE driver_balances
  SET available = available - p_amount,
      card_balance = card_balance + p_amount,
      updated_at = now()
  WHERE driver_id = p_driver_id;

  RETURN jsonb_build_object(
    'success', true,
    'available', v_available - p_amount,
    'card_balance', v_card_balance + p_amount
  );
END;
$$;

-- ── Webhook event deduplication ──────────────────────────────────────────
-- Prevents processing the same Stripe event twice
CREATE TABLE IF NOT EXISTS processed_webhook_events (
  event_id    text PRIMARY KEY,
  event_type  text NOT NULL,
  processed_at timestamptz DEFAULT now()
);

-- Auto-cleanup events older than 7 days
CREATE OR REPLACE FUNCTION cleanup_old_webhook_events()
RETURNS void
LANGUAGE sql
AS $$
  DELETE FROM processed_webhook_events WHERE processed_at < now() - interval '7 days';
$$;

-- ── Tighten driver location staleness ────────────────────────────────────
-- Change find_nearby_drivers to use 60-second staleness instead of 5 minutes
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
    AND v.vehicle_class = ride_vehicle_class
    AND dl.updated_at > now() - interval '60 seconds'  -- was 5 minutes
    AND ST_DWithin(
      dl.location::geography,
      ST_SetSRID(ST_MakePoint(pickup_lng, pickup_lat), 4326)::geography,
      search_radius_m
    )
  ORDER BY distance_m ASC
  LIMIT max_results;
$$;
