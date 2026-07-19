-- ═══════════════════════════════════════════════════════════════════════════
-- 043: Airport Intelligence Platform
--
-- Database-driven airport handling for all US states + DC (extensible to
-- territories/countries via country_code). Catalog presence (FAA NASR) is
-- deliberately separate from TAKEME product coverage: an airport existing in
-- the catalog says nothing about whether TAKEME serves it. Nothing airport-
-- specific is ever hardcoded in client apps — every terminal, drop-off curb,
-- rideshare zone, instruction and fee lives here, draft/published, effective-
-- dated, and source-attributed.
--
-- PostGIS geography is already in use (driver_locations.location).
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Enums --------------------------------------------------------------------

CREATE TYPE airport_coverage_status AS ENUM (
  'cataloged',           -- present in the official source, nothing more
  'passenger_service',   -- recognized commercial passenger service
  'serviceable',         -- inside a TAKEME service area
  'curated',             -- terminals/access points entered (may be draft)
  'verified',            -- operational data reviewed and published
  'temporarily_disabled' -- airport flow switched off operationally
);

CREATE TYPE airport_service_point_type AS ENUM (
  'general_departures_dropoff',
  'airline_departures_dropoff',
  'rideshare_pickup',
  'arrivals_reference'
);

CREATE TYPE airport_instruction_audience AS ENUM ('rider', 'driver', 'both');
CREATE TYPE airport_instruction_direction AS ENUM ('pickup', 'dropoff');
CREATE TYPE trip_airport_direction AS ENUM ('airport_pickup', 'airport_dropoff');
CREATE TYPE airport_selection_method AS ENUM ('airline', 'flight', 'manual', 'verified_fallback');
CREATE TYPE airport_import_status AS ENUM ('running', 'succeeded', 'failed', 'partial');
CREATE TYPE airport_revision_state AS ENUM ('draft', 'published', 'archived');

-- 2. Core catalog -------------------------------------------------------------

CREATE TABLE airports (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  country_code         CHAR(2) NOT NULL DEFAULT 'US',
  state_code           TEXT,                            -- 'WA', 'DC', territories later
  faa_lid              TEXT,                            -- FAA location identifier
  iata_code            TEXT CHECK (iata_code IS NULL OR iata_code ~ '^[A-Z0-9]{3}$'),
  icao_code            TEXT CHECK (icao_code IS NULL OR icao_code ~ '^[A-Z0-9]{4}$'),
  official_name        TEXT NOT NULL,
  display_name         TEXT NOT NULL,
  normalized_name      TEXT NOT NULL,                   -- lower, alnum+space, for controlled alias fallback
  municipality         TEXT,
  timezone             TEXT,
  lat                  NUMERIC(10,7) NOT NULL CHECK (lat >= -90 AND lat <= 90),
  lng                  NUMERIC(10,7) NOT NULL CHECK (lng >= -180 AND lng <= 180),
  location             GEOGRAPHY(POINT, 4326) GENERATED ALWAYS AS
                         (ST_SetSRID(ST_MakePoint(lng::float8, lat::float8), 4326)::geography) STORED,
  geofence             GEOGRAPHY(POLYGON, 4326),        -- curated boundary when available
  detection_radius_m   INTEGER NOT NULL DEFAULT 2500 CHECK (detection_radius_m BETWEEN 100 AND 15000),
  airport_type         TEXT NOT NULL DEFAULT 'airport'
                         CHECK (airport_type IN ('airport','heliport','seaplane_base','gliderport','balloonport','ultralight')),
  ownership_use        TEXT,                            -- e.g. 'PU'/'PR' + use, from NASR
  private_use          BOOLEAN NOT NULL DEFAULT false,  -- facility NOT open to the public
  military_only        BOOLEAN NOT NULL DEFAULT false,
  service_class        TEXT NOT NULL DEFAULT 'unclassified'
                         CHECK (service_class IN ('large_hub','medium_hub','small_hub','nonhub_primary',
                                                  'nonprimary_commercial','reliever','general_aviation','unclassified')),
  enplanements         BIGINT CHECK (enplanements IS NULL OR enplanements >= 0),
  enplanements_year    SMALLINT,
  catalog_status       TEXT NOT NULL DEFAULT 'active' CHECK (catalog_status IN ('active','deactivated')),
  coverage_status      airport_coverage_status NOT NULL DEFAULT 'cataloged',
  active               BOOLEAN NOT NULL DEFAULT true,
  source               JSONB NOT NULL DEFAULT '{}',     -- {provider, version, effective_date, url, ...}
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Identifier uniqueness among ACTIVE catalog rows only — a deactivated source
-- record must never block its successor, but two live airports can't share a code.
CREATE UNIQUE INDEX airports_iata_unique ON airports (country_code, iata_code)
  WHERE iata_code IS NOT NULL AND catalog_status = 'active';
CREATE UNIQUE INDEX airports_icao_unique ON airports (icao_code)
  WHERE icao_code IS NOT NULL AND catalog_status = 'active';
CREATE UNIQUE INDEX airports_faa_lid_unique ON airports (country_code, faa_lid)
  WHERE faa_lid IS NOT NULL AND catalog_status = 'active';

CREATE INDEX idx_airports_location ON airports USING GIST (location);
CREATE INDEX idx_airports_geofence ON airports USING GIST (geofence) WHERE geofence IS NOT NULL;
CREATE INDEX idx_airports_normalized_name ON airports (normalized_name text_pattern_ops);
CREATE INDEX idx_airports_state ON airports (country_code, state_code);
CREATE INDEX idx_airports_coverage ON airports (coverage_status) WHERE active;
CREATE INDEX idx_airports_service_class ON airports (service_class);

CREATE TRIGGER trg_airports_updated BEFORE UPDATE ON airports
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- External identifiers (search-provider place ids, extra aliases). Globally
-- unique per (type, value) among active rows so a lookup is unambiguous.
CREATE TABLE airport_identifiers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  airport_id        UUID NOT NULL REFERENCES airports(id) ON DELETE CASCADE,
  identifier_type   TEXT NOT NULL CHECK (identifier_type IN
                      ('faa_lid','iata','icao','mapbox_place','google_place','alias_normalized')),
  identifier_value  TEXT NOT NULL CHECK (char_length(identifier_value) BETWEEN 1 AND 200),
  provider          TEXT,
  active            BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX airport_identifiers_unique ON airport_identifiers (identifier_type, identifier_value)
  WHERE active;
CREATE INDEX idx_airport_identifiers_airport ON airport_identifiers (airport_id);
CREATE TRIGGER trg_airport_identifiers_updated BEFORE UPDATE ON airport_identifiers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- 3. Airlines -----------------------------------------------------------------

CREATE TABLE airlines (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name    TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  iata_code     TEXT CHECK (iata_code IS NULL OR iata_code ~ '^[A-Z0-9]{2}$'),
  icao_code     TEXT CHECK (icao_code IS NULL OR icao_code ~ '^[A-Z0-9]{3}$'),
  dot_id        TEXT,                                   -- DOT/BTS carrier identifiers
  bts_carrier   TEXT,
  country_code  CHAR(2) NOT NULL DEFAULT 'US',
  aliases       TEXT[] NOT NULL DEFAULT '{}',
  active        BOOLEAN NOT NULL DEFAULT true,
  source        JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX airlines_iata_unique ON airlines (iata_code) WHERE iata_code IS NOT NULL AND active;
CREATE INDEX idx_airlines_display ON airlines (lower(display_name) text_pattern_ops);
CREATE TRIGGER trg_airlines_updated BEFORE UPDATE ON airlines
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Which airlines actively serve which airport, with a documented popularity
-- ranking (BTS T-100-derived or curated with lineage). Historical service is
-- never auto-forever: reporting_period says what the row is based on.
CREATE TABLE airport_airline_services (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  airport_id        UUID NOT NULL REFERENCES airports(id) ON DELETE CASCADE,
  airline_id        UUID NOT NULL REFERENCES airlines(id) ON DELETE CASCADE,
  active            BOOLEAN NOT NULL DEFAULT true,
  popularity_rank   INTEGER CHECK (popularity_rank IS NULL OR popularity_rank >= 1),
  popularity_score  NUMERIC(14,2),                      -- e.g. enplaned passengers over the period
  metrics           JSONB NOT NULL DEFAULT '{}',
  reporting_period  TEXT,                               -- e.g. 'T100 2024-07..2025-06' or 'curated 2026-07'
  source            JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (airport_id, airline_id)
);
CREATE INDEX idx_aas_airport_rank ON airport_airline_services (airport_id, popularity_rank)
  WHERE active;
CREATE TRIGGER trg_aas_updated BEFORE UPDATE ON airport_airline_services
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- 4. Terminals & service points ----------------------------------------------

CREATE TABLE airport_terminals (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  airport_id     UUID NOT NULL REFERENCES airports(id) ON DELETE CASCADE,
  code           TEXT NOT NULL,                          -- 'A', 'Main', '1'
  name           TEXT NOT NULL,
  display_order  INTEGER NOT NULL DEFAULT 0,
  lat            NUMERIC(10,7) CHECK (lat IS NULL OR (lat >= -90 AND lat <= 90)),
  lng            NUMERIC(10,7) CHECK (lng IS NULL OR (lng >= -180 AND lng <= 180)),
  polygon        GEOGRAPHY(POLYGON, 4326),
  active         BOOLEAN NOT NULL DEFAULT true,
  verified       BOOLEAN NOT NULL DEFAULT false,
  valid_from     DATE,
  valid_to       DATE,
  source         JSONB NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to > valid_from),
  UNIQUE (airport_id, code)
);
CREATE TRIGGER trg_airport_terminals_updated BEFORE UPDATE ON airport_terminals
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE airport_service_points (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  airport_id     UUID NOT NULL REFERENCES airports(id) ON DELETE CASCADE,
  terminal_id    UUID REFERENCES airport_terminals(id) ON DELETE SET NULL,
  point_type     airport_service_point_type NOT NULL,
  name           TEXT NOT NULL,
  lat            NUMERIC(10,7) NOT NULL CHECK (lat >= -90 AND lat <= 90),
  lng            NUMERIC(10,7) NOT NULL CHECK (lng >= -180 AND lng <= 180),
  location       GEOGRAPHY(POINT, 4326) GENERATED ALWAYS AS
                   (ST_SetSRID(ST_MakePoint(lng::float8, lat::float8), 4326)::geography) STORED,
  geofence       GEOGRAPHY(POLYGON, 4326),
  level          TEXT,
  door           TEXT,
  zone           TEXT,
  island         TEXT,
  accessibility  TEXT,
  hours          JSONB NOT NULL DEFAULT '{}',
  restrictions   TEXT,
  active         BOOLEAN NOT NULL DEFAULT true,
  verified       BOOLEAN NOT NULL DEFAULT false,
  valid_from     DATE,
  valid_to       DATE,
  source         JSONB NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to > valid_from)
);
CREATE INDEX idx_asp_airport_type ON airport_service_points (airport_id, point_type) WHERE active;
CREATE INDEX idx_asp_location ON airport_service_points USING GIST (location);
CREATE TRIGGER trg_asp_updated BEFORE UPDATE ON airport_service_points
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- A bookable service point may never be the airport centroid: routing riders
-- or drivers to the middle of an airfield is exactly the failure this platform
-- exists to prevent. arrivals_reference rows are non-bookable context and exempt.
CREATE OR REPLACE FUNCTION check_service_point_not_centroid()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_airport airports%ROWTYPE;
BEGIN
  SELECT * INTO v_airport FROM airports WHERE id = NEW.airport_id;
  IF v_airport.id IS NULL THEN
    RAISE EXCEPTION 'airport_not_found';
  END IF;
  IF NEW.point_type <> 'arrivals_reference' AND ST_Distance(
       ST_SetSRID(ST_MakePoint(NEW.lng::float8, NEW.lat::float8), 4326)::geography,
       v_airport.location
     ) < 25 THEN
    RAISE EXCEPTION 'service_point_is_airport_centroid';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_asp_no_centroid BEFORE INSERT OR UPDATE OF lat, lng, point_type
  ON airport_service_points
  FOR EACH ROW EXECUTE FUNCTION check_service_point_not_centroid();

-- 5. Airline → terminal/curb assignments --------------------------------------

CREATE TABLE airport_airline_assignments (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  airport_id                  UUID NOT NULL REFERENCES airports(id) ON DELETE CASCADE,
  airline_id                  UUID NOT NULL REFERENCES airlines(id) ON DELETE CASCADE,
  terminal_id                 UUID REFERENCES airport_terminals(id) ON DELETE RESTRICT,
  departures_service_point_id UUID REFERENCES airport_service_points(id) ON DELETE RESTRICT,
  arrivals_service_point_id   UUID REFERENCES airport_service_points(id) ON DELETE RESTRICT,
  effective_from              DATE,
  effective_to                DATE,
  active                      BOOLEAN NOT NULL DEFAULT true,
  verified                    BOOLEAN NOT NULL DEFAULT false,
  source                      JSONB NOT NULL DEFAULT '{}',
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to > effective_from)
);
-- One active assignment per airport-airline scope.
CREATE UNIQUE INDEX aaa_one_active ON airport_airline_assignments (airport_id, airline_id)
  WHERE active;
CREATE TRIGGER trg_aaa_updated BEFORE UPDATE ON airport_airline_assignments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Referential semantics stronger than FKs: an active assignment may only point
-- at active rows of the right kind, within the same airport. Dropoff slots may
-- never reference a rideshare pickup zone, and pickup slots may never
-- silently reference a departures curb.
CREATE OR REPLACE FUNCTION check_airline_assignment()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_ok BOOLEAN;
  v_type airport_service_point_type;
  v_point_airport UUID;
BEGIN
  IF NOT NEW.active THEN
    RETURN NEW; -- archived rows keep history untouched
  END IF;

  SELECT active INTO v_ok FROM airports WHERE id = NEW.airport_id;
  IF NOT COALESCE(v_ok, false) THEN RAISE EXCEPTION 'assignment_airport_inactive'; END IF;

  SELECT active INTO v_ok FROM airlines WHERE id = NEW.airline_id;
  IF NOT COALESCE(v_ok, false) THEN RAISE EXCEPTION 'assignment_airline_inactive'; END IF;

  IF NEW.terminal_id IS NOT NULL THEN
    SELECT active AND airport_id = NEW.airport_id INTO v_ok
      FROM airport_terminals WHERE id = NEW.terminal_id;
    IF NOT COALESCE(v_ok, false) THEN RAISE EXCEPTION 'assignment_terminal_invalid'; END IF;
  END IF;

  IF NEW.departures_service_point_id IS NOT NULL THEN
    SELECT point_type, airport_id INTO v_type, v_point_airport
      FROM airport_service_points WHERE id = NEW.departures_service_point_id AND active;
    IF v_type IS NULL OR v_point_airport <> NEW.airport_id THEN
      RAISE EXCEPTION 'assignment_departures_point_invalid';
    END IF;
    IF v_type NOT IN ('airline_departures_dropoff', 'general_departures_dropoff') THEN
      RAISE EXCEPTION 'assignment_departures_point_wrong_type';
    END IF;
  END IF;

  IF NEW.arrivals_service_point_id IS NOT NULL THEN
    SELECT point_type, airport_id INTO v_type, v_point_airport
      FROM airport_service_points WHERE id = NEW.arrivals_service_point_id AND active;
    IF v_type IS NULL OR v_point_airport <> NEW.airport_id THEN
      RAISE EXCEPTION 'assignment_arrivals_point_invalid';
    END IF;
    IF v_type NOT IN ('rideshare_pickup', 'arrivals_reference') THEN
      RAISE EXCEPTION 'assignment_arrivals_point_wrong_type';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_aaa_check BEFORE INSERT OR UPDATE ON airport_airline_assignments
  FOR EACH ROW EXECUTE FUNCTION check_airline_assignment();

-- An airport may only be promoted to 'verified' when its operational floor
-- exists: an active verified general departures drop-off AND an active
-- verified rideshare pickup zone.
CREATE OR REPLACE FUNCTION check_airport_verified_floor()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.coverage_status = 'verified' AND
     (OLD.coverage_status IS DISTINCT FROM 'verified') THEN
    IF NOT EXISTS (
      SELECT 1 FROM airport_service_points
      WHERE airport_id = NEW.id AND point_type = 'general_departures_dropoff'
        AND active AND verified
    ) THEN
      RAISE EXCEPTION 'verified_requires_general_dropoff';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM airport_service_points
      WHERE airport_id = NEW.id AND point_type = 'rideshare_pickup'
        AND active AND verified
    ) THEN
      RAISE EXCEPTION 'verified_requires_rideshare_pickup';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_airports_verified_floor BEFORE UPDATE OF coverage_status ON airports
  FOR EACH ROW EXECUTE FUNCTION check_airport_verified_floor();

-- 6. Instructions & rules -----------------------------------------------------

CREATE TABLE airport_instructions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  airport_id        UUID NOT NULL REFERENCES airports(id) ON DELETE CASCADE,
  service_point_id  UUID REFERENCES airport_service_points(id) ON DELETE CASCADE,
  audience          airport_instruction_audience NOT NULL DEFAULT 'both',
  direction         airport_instruction_direction NOT NULL,
  locale            TEXT NOT NULL DEFAULT 'en',
  title             TEXT NOT NULL,
  body              TEXT NOT NULL,
  image_url         TEXT,
  display_order     INTEGER NOT NULL DEFAULT 0,
  active            BOOLEAN NOT NULL DEFAULT true,
  version           INTEGER NOT NULL DEFAULT 1,
  source            JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_airport ON airport_instructions (airport_id, direction, display_order) WHERE active;
CREATE TRIGGER trg_ai_updated BEFORE UPDATE ON airport_instructions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Structured, effective-dated operational rules; airport fees live here
-- (rule_type 'airport_fee', config {amount, currency, direction}). Pricing
-- reads these — never client constants.
CREATE TABLE airport_rules (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  airport_id     UUID NOT NULL REFERENCES airports(id) ON DELETE CASCADE,
  rule_type      TEXT NOT NULL CHECK (rule_type IN
                   ('airport_fee','pickup_wait','geofence_rule','access_restriction','custom')),
  config         JSONB NOT NULL DEFAULT '{}',
  effective_from DATE,
  effective_to   DATE,
  active         BOOLEAN NOT NULL DEFAULT true,
  source         JSONB NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to > effective_from)
);
CREATE INDEX idx_ar_airport ON airport_rules (airport_id, rule_type) WHERE active;
CREATE TRIGGER trg_ar_updated BEFORE UPDATE ON airport_rules
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- 7. Import lineage & revisions -----------------------------------------------

CREATE TABLE airport_data_imports (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source          TEXT NOT NULL,                        -- 'faa_nasr','faa_enplanements','bts_t100','curated'
  source_version  TEXT,
  effective_date  DATE,
  checksum        TEXT,
  status          airport_import_status NOT NULL DEFAULT 'running',
  counts          JSONB NOT NULL DEFAULT '{}',          -- {inserted, updated, deactivated, skipped}
  error_summary   TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ
);
CREATE INDEX idx_adi_source ON airport_data_imports (source, started_at DESC);

CREATE TABLE airport_data_revisions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type  TEXT NOT NULL,
  entity_id    UUID NOT NULL,
  state        airport_revision_state NOT NULL DEFAULT 'draft',
  before       JSONB,
  after        JSONB,
  editor       TEXT,
  reviewer     TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);
CREATE INDEX idx_adr_entity ON airport_data_revisions (entity_type, entity_id, created_at DESC);

-- 8. Trip snapshot ------------------------------------------------------------
-- The exact airport context a ride was booked with — immutable at booking
-- time. Later operational edits to airports must never change what an
-- in-flight trip displays; both apps read this snapshot, not live config.

CREATE TABLE trip_airport_context (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id          UUID NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  route_point_id   UUID REFERENCES ride_route_points(id) ON DELETE CASCADE,
  direction        trip_airport_direction NOT NULL,
  airport_id       UUID NOT NULL REFERENCES airports(id),
  airline_id       UUID REFERENCES airlines(id),
  terminal_id      UUID REFERENCES airport_terminals(id),
  service_point_id UUID NOT NULL REFERENCES airport_service_points(id),
  flight_number    TEXT CHECK (flight_number IS NULL OR flight_number ~ '^[A-Z0-9]{2,3}\s?[0-9]{1,4}[A-Z]?$'),
  selection_method airport_selection_method NOT NULL,
  snapshot         JSONB NOT NULL,  -- names, instructions, coordinates, fee, source versions
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX tac_scope_unique ON trip_airport_context
  (ride_id, direction, COALESCE(route_point_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX idx_tac_ride ON trip_airport_context (ride_id);
CREATE TRIGGER trg_tac_updated BEFORE UPDATE ON trip_airport_context
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- 9. RLS ----------------------------------------------------------------------
-- All airport catalog/config reads flow through the API's server-side
-- resolution layer (published-only projections, bounded caching). Clients get
-- NO direct read of catalog tables: draft rows, source metadata and audit
-- trails stay server-side. The one client-readable table is the trip snapshot,
-- scoped to the trip's rider and assigned driver like ride_route_points (042).

ALTER TABLE airports                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE airport_identifiers        ENABLE ROW LEVEL SECURITY;
ALTER TABLE airlines                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE airport_airline_services   ENABLE ROW LEVEL SECURITY;
ALTER TABLE airport_terminals          ENABLE ROW LEVEL SECURITY;
ALTER TABLE airport_service_points     ENABLE ROW LEVEL SECURITY;
ALTER TABLE airport_airline_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE airport_instructions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE airport_rules              ENABLE ROW LEVEL SECURITY;
ALTER TABLE airport_data_imports       ENABLE ROW LEVEL SECURITY;
ALTER TABLE airport_data_revisions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE trip_airport_context       ENABLE ROW LEVEL SECURITY;

CREATE POLICY tac_select_rider ON trip_airport_context
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM rides r
      WHERE r.id = trip_airport_context.ride_id
        AND r.rider_id = (SELECT public.app_user_id())
    )
  );

CREATE POLICY tac_select_driver ON trip_airport_context
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM rides r
      WHERE r.id = trip_airport_context.ride_id
        AND r.assigned_driver_id = public.get_driver_id()
    )
  );

-- Realtime: both apps observe the snapshot rows of their own trips.
ALTER PUBLICATION supabase_realtime ADD TABLE public.trip_airport_context;
