-- ═══════════════════════════════════════════════════════════════════════════
-- TAKEME MOBILITY — Production Schema v1
-- Run in Supabase Dashboard → SQL Editor
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Extensions ───────────────────────────────────────────────────────────

-- gen_random_uuid() is in pg_catalog (PG13+), so no uuid-ossp dependency and no
-- search_path assumptions. uuid-ossp lives in the `extensions` schema, which is
-- on the search_path in the dashboard SQL Editor but not under `supabase db push`.
CREATE EXTENSION IF NOT EXISTS "postgis";          -- geo queries on driver locations


-- ── Enum types ───────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE ride_status AS ENUM (
    'pending',
    'quoted',
    'searching_driver',
    'driver_assigned',
    'driver_arriving',
    'arrived',
    'in_progress',
    'completed',
    'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE vehicle_class AS ENUM ('economy', 'comfort', 'premium');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE payment_status AS ENUM (
    'pending',
    'authorized',
    'captured',
    'failed',
    'refunded',
    'disputed'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE driver_status AS ENUM ('offline', 'available', 'busy', 'on_trip');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. RIDERS
--    Extends auth.users. One row per registered rider.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS riders (
  id            UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name     TEXT,
  email         TEXT,
  phone         TEXT,
  avatar_url    TEXT,
  rating        NUMERIC(3,2) DEFAULT 5.00 CHECK (rating >= 1 AND rating <= 5),
  total_rides   INTEGER DEFAULT 0,
  default_payment_method TEXT,            -- Stripe payment method ID
  stripe_customer_id     TEXT,            -- Stripe customer ID
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_riders_email ON riders(email);
CREATE INDEX IF NOT EXISTS idx_riders_stripe ON riders(stripe_customer_id);


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. DRIVERS
--    Independent table — drivers are not auth.users (they use a separate
--    onboarding flow in production). Linked to vehicles.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS drivers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name       TEXT NOT NULL,
  email           TEXT UNIQUE,
  phone           TEXT NOT NULL,
  avatar_url      TEXT,
  license_number  TEXT NOT NULL,
  status          driver_status DEFAULT 'offline',
  rating          NUMERIC(3,2) DEFAULT 5.00 CHECK (rating >= 1 AND rating <= 5),
  total_trips     INTEGER DEFAULT 0,
  is_verified     BOOLEAN DEFAULT FALSE,
  is_active       BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_drivers_status ON drivers(status);
CREATE INDEX IF NOT EXISTS idx_drivers_active ON drivers(is_active, is_verified);


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. VEHICLES
--    Each driver has one active vehicle. Stores class for fare calculation.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS vehicles (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id       UUID NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  vehicle_class   vehicle_class NOT NULL DEFAULT 'economy',
  make            TEXT NOT NULL,                 -- e.g. "BMW"
  model           TEXT NOT NULL,                 -- e.g. "530i"
  year            INTEGER,
  color           TEXT,
  plate_number    TEXT NOT NULL,
  capacity        INTEGER DEFAULT 4,
  is_active       BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vehicles_driver ON vehicles(driver_id);
CREATE INDEX IF NOT EXISTS idx_vehicles_class ON vehicles(vehicle_class);


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. DRIVER_LOCATIONS
--    Real-time GPS positions. Updated frequently, queried spatially.
--    Kept separate from drivers table for write performance.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS driver_locations (
  driver_id     UUID PRIMARY KEY REFERENCES drivers(id) ON DELETE CASCADE,
  location      GEOGRAPHY(POINT, 4326) NOT NULL, -- PostGIS point
  heading       NUMERIC(5,2),                     -- compass bearing 0-360
  speed_kmh     NUMERIC(5,1),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

-- Spatial index for "find nearest drivers" queries
CREATE INDEX IF NOT EXISTS idx_driver_locations_geo
  ON driver_locations USING GIST(location);


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. RIDE_QUOTES
--    Pre-ride fare estimates. Created before booking, referenced by rides.
--    Immutable after creation — the rider saw this price.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ride_quotes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rider_id          UUID NOT NULL REFERENCES riders(id) ON DELETE CASCADE,

  -- Locations
  pickup_address    TEXT NOT NULL,
  pickup_lat        NUMERIC(10,7) NOT NULL,
  pickup_lng        NUMERIC(10,7) NOT NULL,
  dropoff_address   TEXT NOT NULL,
  dropoff_lat       NUMERIC(10,7) NOT NULL,
  dropoff_lng       NUMERIC(10,7) NOT NULL,

  -- Route
  distance_km       NUMERIC(8,2) NOT NULL,
  duration_min      INTEGER NOT NULL,
  route_polyline    TEXT,                         -- encoded polyline

  -- Fare breakdown
  vehicle_class     vehicle_class NOT NULL,
  base_fare         NUMERIC(10,2) NOT NULL,
  distance_fare     NUMERIC(10,2) NOT NULL,
  time_fare         NUMERIC(10,2) NOT NULL,
  surge_multiplier  NUMERIC(4,2) DEFAULT 1.00,
  total_fare        NUMERIC(10,2) NOT NULL,       -- what the rider sees
  currency          CHAR(3) DEFAULT 'USD',

  expires_at        TIMESTAMPTZ NOT NULL,          -- quotes expire (e.g. 5 min)
  created_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ride_quotes_rider ON ride_quotes(rider_id);
CREATE INDEX IF NOT EXISTS idx_ride_quotes_expires ON ride_quotes(expires_at);


-- ═══════════════════════════════════════════════════════════════════════════
-- 6. RIDES
--    The core table. One row per trip. Full lifecycle tracking.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS rides (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rider_id            UUID NOT NULL REFERENCES riders(id) ON DELETE CASCADE,
  assigned_driver_id  UUID REFERENCES drivers(id) ON DELETE SET NULL,
  vehicle_id          UUID REFERENCES vehicles(id) ON DELETE SET NULL,
  quote_id            UUID REFERENCES ride_quotes(id) ON DELETE SET NULL,

  -- Status
  status              ride_status NOT NULL DEFAULT 'pending',
  cancel_reason       TEXT,
  cancelled_by        TEXT CHECK (cancelled_by IN ('rider', 'driver', 'system')),

  -- Locations
  pickup_address      TEXT NOT NULL,
  pickup_lat          NUMERIC(10,7) NOT NULL,
  pickup_lng          NUMERIC(10,7) NOT NULL,
  dropoff_address     TEXT NOT NULL,
  dropoff_lat         NUMERIC(10,7) NOT NULL,
  dropoff_lng         NUMERIC(10,7) NOT NULL,

  -- Route
  vehicle_class       vehicle_class NOT NULL DEFAULT 'economy',
  distance_km         NUMERIC(8,2),
  duration_min        INTEGER,
  route_polyline      TEXT,

  -- Fare
  estimated_fare      NUMERIC(10,2) NOT NULL,
  final_fare          NUMERIC(10,2),              -- set at completion
  currency            CHAR(3) DEFAULT 'USD',
  surge_multiplier    NUMERIC(4,2) DEFAULT 1.00,

  -- Timing
  requested_at        TIMESTAMPTZ DEFAULT now(),
  driver_assigned_at  TIMESTAMPTZ,
  driver_arrived_at   TIMESTAMPTZ,
  trip_started_at     TIMESTAMPTZ,
  trip_completed_at   TIMESTAMPTZ,
  cancelled_at        TIMESTAMPTZ,

  -- Rating
  rider_rating        NUMERIC(2,1) CHECK (rider_rating >= 1 AND rider_rating <= 5),
  driver_rating       NUMERIC(2,1) CHECK (driver_rating >= 1 AND driver_rating <= 5),

  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rides_rider ON rides(rider_id);
CREATE INDEX IF NOT EXISTS idx_rides_driver ON rides(assigned_driver_id);
CREATE INDEX IF NOT EXISTS idx_rides_status ON rides(status);
CREATE INDEX IF NOT EXISTS idx_rides_requested ON rides(requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_rides_active
  ON rides(status) WHERE status NOT IN ('completed', 'cancelled');


-- ═══════════════════════════════════════════════════════════════════════════
-- 7. RIDE_EVENTS
--    Append-only audit log. Every state change is recorded with timestamp
--    and optional metadata. Critical for debugging and dispute resolution.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ride_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id     UUID NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL,                      -- e.g. 'status_change', 'location_update', 'fare_adjusted'
  old_status  ride_status,
  new_status  ride_status,
  actor       TEXT,                               -- 'rider', 'driver', 'system'
  metadata    JSONB DEFAULT '{}',                 -- flexible payload
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ride_events_ride ON ride_events(ride_id);
CREATE INDEX IF NOT EXISTS idx_ride_events_type ON ride_events(event_type);
CREATE INDEX IF NOT EXISTS idx_ride_events_created ON ride_events(created_at DESC);


-- ═══════════════════════════════════════════════════════════════════════════
-- 8. PAYMENTS
--    One payment per ride. Tracks Stripe lifecycle.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS payments (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id               UUID NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  rider_id              UUID NOT NULL REFERENCES riders(id) ON DELETE CASCADE,

  -- Stripe
  stripe_payment_intent TEXT UNIQUE,
  stripe_charge_id      TEXT,
  payment_method_type   TEXT,                     -- 'card', 'apple_pay', 'google_pay'

  -- Amount
  amount                NUMERIC(10,2) NOT NULL,
  currency              CHAR(3) DEFAULT 'USD',
  status                payment_status NOT NULL DEFAULT 'pending',

  -- Timing
  authorized_at         TIMESTAMPTZ,
  captured_at           TIMESTAMPTZ,
  failed_at             TIMESTAMPTZ,
  refunded_at           TIMESTAMPTZ,
  failure_reason        TEXT,

  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payments_ride ON payments(ride_id);
CREATE INDEX IF NOT EXISTS idx_payments_rider ON payments(rider_id);
CREATE INDEX IF NOT EXISTS idx_payments_stripe ON payments(stripe_payment_intent);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);


-- ═══════════════════════════════════════════════════════════════════════════
-- AUTO-UPDATE TRIGGERS
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_riders_updated    BEFORE UPDATE ON riders          FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_drivers_updated   BEFORE UPDATE ON drivers         FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_vehicles_updated  BEFORE UPDATE ON vehicles        FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_rides_updated     BEFORE UPDATE ON rides           FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_payments_updated  BEFORE UPDATE ON payments        FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ═══════════════════════════════════════════════════════════════════════════
-- AUTO-CREATE RIDER PROFILE ON SIGNUP
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO riders (id, full_name, email)
  VALUES (
    NEW.id,
    NEW.raw_user_meta_data->>'full_name',
    NEW.email
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Drop existing trigger if it exists (from old schema)
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();


-- ═══════════════════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE riders           ENABLE ROW LEVEL SECURITY;
ALTER TABLE drivers          ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicles         ENABLE ROW LEVEL SECURITY;
ALTER TABLE driver_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ride_quotes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE rides            ENABLE ROW LEVEL SECURITY;
ALTER TABLE ride_events      ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments         ENABLE ROW LEVEL SECURITY;

-- ── Riders: own data only ────────────────────────────────────────────────

CREATE POLICY "riders_select_own"
  ON riders FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "riders_update_own"
  ON riders FOR UPDATE
  USING (auth.uid() = id);

-- ── Drivers: readable by authenticated users (riders see driver info) ───

CREATE POLICY "drivers_select_authenticated"
  ON drivers FOR SELECT
  TO authenticated
  USING (TRUE);

-- ── Vehicles: readable by authenticated users ───────────────────────────

CREATE POLICY "vehicles_select_authenticated"
  ON vehicles FOR SELECT
  TO authenticated
  USING (TRUE);

-- ── Driver locations: readable by authenticated users (map display) ─────

CREATE POLICY "driver_locations_select_authenticated"
  ON driver_locations FOR SELECT
  TO authenticated
  USING (TRUE);

-- ── Ride quotes: own data only ──────────────────────────────────────────

CREATE POLICY "ride_quotes_select_own"
  ON ride_quotes FOR SELECT
  USING (auth.uid() = rider_id);

CREATE POLICY "ride_quotes_insert_own"
  ON ride_quotes FOR INSERT
  WITH CHECK (auth.uid() = rider_id);

-- ── Rides: own data only ────────────────────────────────────────────────

CREATE POLICY "rides_select_own"
  ON rides FOR SELECT
  USING (auth.uid() = rider_id);

CREATE POLICY "rides_insert_own"
  ON rides FOR INSERT
  WITH CHECK (auth.uid() = rider_id);

CREATE POLICY "rides_update_own"
  ON rides FOR UPDATE
  USING (auth.uid() = rider_id);

-- ── Ride events: viewable if rider owns the ride ────────────────────────

CREATE POLICY "ride_events_select_own"
  ON ride_events FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM rides WHERE rides.id = ride_events.ride_id AND rides.rider_id = auth.uid()
    )
  );

-- ── Payments: own data only ─────────────────────────────────────────────

CREATE POLICY "payments_select_own"
  ON payments FOR SELECT
  USING (auth.uid() = rider_id);

CREATE POLICY "payments_insert_own"
  ON payments FOR INSERT
  WITH CHECK (auth.uid() = rider_id);
