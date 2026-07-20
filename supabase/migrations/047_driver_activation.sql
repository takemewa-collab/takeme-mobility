-- ═══════════════════════════════════════════════════════════════════════════
-- 047 — Driver activation platform
-- Market-driven requirements engine, versioned legal consents, document
-- review lifecycle, background-check cases, rental waitlist, training,
-- activation audit trail, private driver-docs storage.
-- Supersedes the prepared (never-applied) 037_vehicle_compliance draft.
-- Additive only; no destructive changes to existing data.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Operating markets
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS onboarding_markets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key           TEXT NOT NULL UNIQUE,          -- 'seattle_wa_us'
  country_code  TEXT NOT NULL,                 -- ISO-3166 alpha-2
  region_code   TEXT,                          -- state/province code
  city          TEXT,
  display_name  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'waitlisted', 'inactive')),
  -- Vehicle/EV policy for the market. Consumed by the requirements engine;
  -- never hardcode these values in app code.
  policies      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_onboarding_markets_updated ON onboarding_markets;
CREATE TRIGGER trg_onboarding_markets_updated
  BEFORE UPDATE ON onboarding_markets
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE onboarding_markets ENABLE ROW LEVEL SECURITY;
-- Market catalog is safe, non-sensitive reference data.
CREATE POLICY onboarding_markets_select_all ON onboarding_markets
  FOR SELECT TO authenticated USING (true);

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Requirement definitions (configurable policy, not hardcoded screens)
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS requirement_definitions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key                   TEXT NOT NULL,
  market_id             UUID REFERENCES onboarding_markets(id) ON DELETE CASCADE,
  -- NULL arrays mean "applies to all".
  applicant_types       TEXT[],
  vehicle_relationships TEXT[],
  category              TEXT NOT NULL CHECK (category IN (
    'identity', 'legal', 'vehicle', 'background', 'training',
    'market_permit', 'opportunity'
  )),
  required              BOOLEAN NOT NULL DEFAULT TRUE,
  blocking              BOOLEAN NOT NULL DEFAULT TRUE,
  review_method         TEXT NOT NULL DEFAULT 'document_review' CHECK (review_method IN (
    'auto', 'document_review', 'provider', 'manual', 'quiz', 'none'
  )),
  title                 TEXT NOT NULL,
  summary               TEXT NOT NULL DEFAULT '',
  instructions          TEXT NOT NULL DEFAULT '',
  external_url          TEXT,
  doc_kinds             TEXT[],               -- accepted driver_documents.doc_type values
  depends_on            TEXT[],               -- requirement keys that must be approved first
  -- Free-form knobs: requires_back, expiry_source, renewal_window_days,
  -- quiz {questions, pass_score, max_attempts}, compliance_review, etc.
  config                JSONB NOT NULL DEFAULT '{}'::jsonb,
  sort_order            INTEGER NOT NULL DEFAULT 100,
  active                BOOLEAN NOT NULL DEFAULT TRUE,
  effective_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (key, market_id)
);

CREATE INDEX IF NOT EXISTS idx_requirement_definitions_market
  ON requirement_definitions(market_id, active);

DROP TRIGGER IF EXISTS trg_requirement_definitions_updated ON requirement_definitions;
CREATE TRIGGER trg_requirement_definitions_updated
  BEFORE UPDATE ON requirement_definitions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE requirement_definitions ENABLE ROW LEVEL SECURITY;
CREATE POLICY requirement_definitions_select_all ON requirement_definitions
  FOR SELECT TO authenticated USING (active = TRUE);

-- ───────────────────────────────────────────────────────────────────────────
-- 3. driver_applications — extend into the application root
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE driver_applications
  ADD COLUMN IF NOT EXISTS market_id            UUID REFERENCES onboarding_markets(id),
  ADD COLUMN IF NOT EXISTS applicant_type       TEXT CHECK (applicant_type IN (
    'individual_owner', 'individual_lease', 'rental_seeker',
    'fleet_driver', 'fleet_owner', 'livery_operator', 'subcarrier'
  )),
  ADD COLUMN IF NOT EXISTS vehicle_relationship TEXT CHECK (vehicle_relationship IN (
    'personal_owned', 'personal_leased', 'takeme_rental',
    'fleet_assigned', 'commercial_livery', 'none'
  )),
  ADD COLUMN IF NOT EXISTS vin                  TEXT,
  ADD COLUMN IF NOT EXISTS plate_state          TEXT,
  ADD COLUMN IF NOT EXISTS doors                INTEGER,
  ADD COLUMN IF NOT EXISTS seatbelts            INTEGER,
  ADD COLUMN IF NOT EXISTS powertrain           TEXT,
  ADD COLUMN IF NOT EXISTS body_type            TEXT,
  ADD COLUMN IF NOT EXISTS vehicle_verification JSONB,   -- decode/eligibility snapshot
  ADD COLUMN IF NOT EXISTS preferences          JSONB,   -- optional driving preferences (never used for compliance decisions)
  ADD COLUMN IF NOT EXISTS preferred_language   TEXT NOT NULL DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS submitted_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS activated_at         TIMESTAMPTZ;

-- Widen the status model to include a live in-progress stage.
ALTER TABLE driver_applications DROP CONSTRAINT IF EXISTS driver_applications_status_check;
ALTER TABLE driver_applications ADD CONSTRAINT driver_applications_status_check
  CHECK (status IN ('in_progress', 'pending', 'approved', 'rejected', 'suspended'));

-- Applicants may update their own in-flight application (fields only; status
-- transitions to approved/rejected are service-role writes).
DROP POLICY IF EXISTS driver_apps_update_own ON driver_applications;
CREATE POLICY driver_apps_update_own ON driver_applications
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT public.app_user_id()) AND status IN ('in_progress', 'pending'))
  WITH CHECK (user_id = (SELECT public.app_user_id()) AND status IN ('in_progress', 'pending'));

CREATE INDEX IF NOT EXISTS idx_driver_apps_market ON driver_applications(market_id, status);

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Per-application requirement instances
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS application_requirements (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id   UUID NOT NULL REFERENCES driver_applications(id) ON DELETE CASCADE,
  definition_id    UUID NOT NULL REFERENCES requirement_definitions(id),
  requirement_key  TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN (
    'not_started', 'in_progress', 'submitted', 'under_review', 'needs_action',
    'approved', 'rejected', 'expiring_soon', 'expired', 'waived',
    'not_applicable', 'blocked'
  )),
  required         BOOLEAN NOT NULL DEFAULT TRUE,
  blocking         BOOLEAN NOT NULL DEFAULT TRUE,
  due_at           TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ,
  rejection_reason TEXT,
  review_note      TEXT,
  waived_by        UUID,
  waived_reason    TEXT,
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (application_id, requirement_key)
);

CREATE INDEX IF NOT EXISTS idx_application_requirements_app
  ON application_requirements(application_id, status);
CREATE INDEX IF NOT EXISTS idx_application_requirements_review
  ON application_requirements(status) WHERE status IN ('submitted', 'under_review');
CREATE INDEX IF NOT EXISTS idx_application_requirements_expiry
  ON application_requirements(expires_at) WHERE expires_at IS NOT NULL;

DROP TRIGGER IF EXISTS trg_application_requirements_updated ON application_requirements;
CREATE TRIGGER trg_application_requirements_updated
  BEFORE UPDATE ON application_requirements
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE application_requirements ENABLE ROW LEVEL SECURITY;
CREATE POLICY application_requirements_select_own ON application_requirements
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM driver_applications a
    WHERE a.id = application_requirements.application_id
      AND a.user_id = (SELECT public.app_user_id())
  ));
-- All writes are server-side (service role / engine).

-- ───────────────────────────────────────────────────────────────────────────
-- 5. driver_documents — extend into a versioned review ledger
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE driver_documents
  ALTER COLUMN file_url DROP NOT NULL;

ALTER TABLE driver_documents
  ADD COLUMN IF NOT EXISTS storage_path               TEXT,
  ADD COLUMN IF NOT EXISTS application_requirement_id UUID REFERENCES application_requirements(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejection_reason           TEXT,
  ADD COLUMN IF NOT EXISTS reviewed_by                UUID,
  ADD COLUMN IF NOT EXISTS mime_type                  TEXT,
  ADD COLUMN IF NOT EXISTS size_bytes                 INTEGER;

ALTER TABLE driver_documents DROP CONSTRAINT IF EXISTS driver_documents_doc_type_check;
ALTER TABLE driver_documents ADD CONSTRAINT driver_documents_doc_type_check
  CHECK (doc_type IN (
    'license_front', 'license_back', 'insurance', 'registration', 'inspection',
    'profile_photo', 'vehicle_photo', 'chauffeur_credential', 'limousine_decal',
    'business_license', 'liability_certificate', 'airport_permit',
    'for_hire_permit', 'training_certificate', 'background_check', 'other'
  ));

ALTER TABLE driver_documents DROP CONSTRAINT IF EXISTS driver_documents_status_check;
ALTER TABLE driver_documents ADD CONSTRAINT driver_documents_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'superseded'));

CREATE INDEX IF NOT EXISTS idx_driver_documents_requirement
  ON driver_documents(application_requirement_id) WHERE application_requirement_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_driver_documents_review_queue
  ON driver_documents(status, created_at) WHERE status = 'pending';

-- ───────────────────────────────────────────────────────────────────────────
-- 6. Versioned legal documents + append-only consent records
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS legal_documents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key           TEXT NOT NULL,          -- 'driver_terms', 'privacy_policy', ...
  version       INTEGER NOT NULL,
  locale        TEXT NOT NULL DEFAULT 'en',
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  content_hash  TEXT NOT NULL,          -- sha256 of body
  requires_scroll BOOLEAN NOT NULL DEFAULT FALSE,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  effective_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (key, version, locale)
);

ALTER TABLE legal_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY legal_documents_select_active ON legal_documents
  FOR SELECT TO authenticated USING (active = TRUE);

CREATE TABLE IF NOT EXISTS consent_records (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  application_id    UUID REFERENCES driver_applications(id) ON DELETE SET NULL,
  legal_document_id UUID NOT NULL REFERENCES legal_documents(id),
  document_key      TEXT NOT NULL,
  version           INTEGER NOT NULL,
  locale            TEXT NOT NULL,
  content_hash      TEXT NOT NULL,
  accepted_at       TIMESTAMPTZ NOT NULL DEFAULT now(),   -- server timestamp
  client_accepted_at TIMESTAMPTZ,                          -- device-reported
  device            JSONB NOT NULL DEFAULT '{}'::jsonb,    -- platform, app version, session
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_consent_records_user ON consent_records(user_id, document_key);

ALTER TABLE consent_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY consent_records_select_own ON consent_records
  FOR SELECT TO authenticated USING (user_id = (SELECT public.app_user_id()));
-- Immutable audit trail: nobody edits or deletes consents from a client.
REVOKE UPDATE, DELETE ON consent_records FROM authenticated, anon;

-- ───────────────────────────────────────────────────────────────────────────
-- 7. Background check lifecycle (provider-agnostic)
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS background_check_cases (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  application_id   UUID NOT NULL REFERENCES driver_applications(id) ON DELETE CASCADE,
  provider         TEXT NOT NULL DEFAULT 'manual',
  provider_case_id TEXT,
  status           TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN (
    'not_started', 'disclosure_required', 'consent_required', 'info_required',
    'submitted', 'provider_pending', 'candidate_action', 'under_review',
    'clear', 'consider', 'pre_adverse', 'dispute', 'adverse_final',
    'expired', 'recheck_required', 'provider_unavailable'
  )),
  -- Non-sensitive summary only. Full reports stay with the provider; they are
  -- never mirrored into this table or returned to clients.
  result_summary   JSONB,
  submitted_at     TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_background_check_one_open_per_app
  ON background_check_cases(application_id)
  WHERE status NOT IN ('adverse_final', 'expired');
CREATE INDEX IF NOT EXISTS idx_background_check_provider_case
  ON background_check_cases(provider, provider_case_id);

DROP TRIGGER IF EXISTS trg_background_check_cases_updated ON background_check_cases;
CREATE TRIGGER trg_background_check_cases_updated
  BEFORE UPDATE ON background_check_cases
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE background_check_cases ENABLE ROW LEVEL SECURITY;
CREATE POLICY background_check_cases_select_own ON background_check_cases
  FOR SELECT TO authenticated USING (user_id = (SELECT public.app_user_id()));
-- Writes are service-role only.

-- Provider webhook events: idempotency + audit. Service-role only.
CREATE TABLE IF NOT EXISTS background_check_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider     TEXT NOT NULL,
  event_id     TEXT NOT NULL,
  case_id      UUID REFERENCES background_check_cases(id) ON DELETE SET NULL,
  event_type   TEXT NOT NULL,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  processed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, event_id)
);

ALTER TABLE background_check_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON background_check_events FROM authenticated, anon;

-- ───────────────────────────────────────────────────────────────────────────
-- 8. TAKEME rental interest waitlist
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rental_waitlist (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  application_id UUID REFERENCES driver_applications(id) ON DELETE SET NULL,
  market_id      UUID NOT NULL REFERENCES onboarding_markets(id),
  vehicle_size   TEXT NOT NULL DEFAULT 'standard'
    CHECK (vehicle_size IN ('standard', 'large')),
  pickup_area    TEXT,
  status         TEXT NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting', 'notified', 'fulfilled', 'cancelled')),
  notify_opt_in  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One live waitlist entry per user per market.
CREATE UNIQUE INDEX IF NOT EXISTS idx_rental_waitlist_one_waiting
  ON rental_waitlist(user_id, market_id) WHERE status = 'waiting';

DROP TRIGGER IF EXISTS trg_rental_waitlist_updated ON rental_waitlist;
CREATE TRIGGER trg_rental_waitlist_updated
  BEFORE UPDATE ON rental_waitlist
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE rental_waitlist ENABLE ROW LEVEL SECURITY;
CREATE POLICY rental_waitlist_select_own ON rental_waitlist
  FOR SELECT TO authenticated USING (user_id = (SELECT public.app_user_id()));

-- ───────────────────────────────────────────────────────────────────────────
-- 9. Training attempts (quiz results per requirement)
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS training_attempts (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_requirement_id UUID NOT NULL REFERENCES application_requirements(id) ON DELETE CASCADE,
  user_id                    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  module_version             INTEGER NOT NULL DEFAULT 1,
  score                      NUMERIC(5,2),
  passed                     BOOLEAN NOT NULL DEFAULT FALSE,
  answers                    JSONB NOT NULL DEFAULT '[]'::jsonb,
  started_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at               TIMESTAMPTZ,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_training_attempts_requirement
  ON training_attempts(application_requirement_id);

ALTER TABLE training_attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY training_attempts_select_own ON training_attempts
  FOR SELECT TO authenticated USING (user_id = (SELECT public.app_user_id()));

-- ───────────────────────────────────────────────────────────────────────────
-- 10. Activation decisions (append-only audit of the server-side gate)
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS activation_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL REFERENCES driver_applications(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL,
  decision       TEXT NOT NULL CHECK (decision IN (
    'eligible', 'ineligible', 'pending_review', 'temporarily_blocked',
    'suspended', 'expired_requirement'
  )),
  reason_codes   TEXT[] NOT NULL DEFAULT '{}',
  snapshot       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_activation_events_app
  ON activation_events(application_id, created_at DESC);

ALTER TABLE activation_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY activation_events_select_own ON activation_events
  FOR SELECT TO authenticated USING (user_id = (SELECT public.app_user_id()));
REVOKE UPDATE, DELETE ON activation_events FROM authenticated, anon;

-- ───────────────────────────────────────────────────────────────────────────
-- 11. Onboarding audit events (state transitions; service-role only)
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS onboarding_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID REFERENCES driver_applications(id) ON DELETE CASCADE,
  user_id        UUID,
  actor          TEXT NOT NULL CHECK (actor IN ('driver', 'admin', 'system', 'provider')),
  actor_id       UUID,
  event          TEXT NOT NULL,
  detail         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_onboarding_events_app
  ON onboarding_events(application_id, created_at DESC);

ALTER TABLE onboarding_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON onboarding_events FROM authenticated, anon;

-- ───────────────────────────────────────────────────────────────────────────
-- 12. Vehicle compliance columns + duplicate protection
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE vehicles
  ADD COLUMN IF NOT EXISTS registration_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (registration_status IN ('pending', 'valid', 'expired', 'rejected')),
  ADD COLUMN IF NOT EXISTS insurance_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (insurance_status IN ('pending', 'valid', 'expired', 'rejected')),
  ADD COLUMN IF NOT EXISTS inspection_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (inspection_status IN ('pending', 'valid', 'expired', 'rejected', 'not_required')),
  ADD COLUMN IF NOT EXISTS photo_url            TEXT,
  ADD COLUMN IF NOT EXISTS vin                  TEXT,
  ADD COLUMN IF NOT EXISTS plate_state          TEXT,
  ADD COLUMN IF NOT EXISTS doors                INTEGER,
  ADD COLUMN IF NOT EXISTS seatbelts            INTEGER,
  ADD COLUMN IF NOT EXISTS powertrain           TEXT,
  ADD COLUMN IF NOT EXISTS body_type            TEXT,
  ADD COLUMN IF NOT EXISTS registration_expires DATE,
  ADD COLUMN IF NOT EXISTS insurance_expires    DATE,
  ADD COLUMN IF NOT EXISTS inspection_expires   DATE;

-- No two active vehicles may share a VIN or a (state, plate) pair.
CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicles_active_vin
  ON vehicles (upper(vin)) WHERE vin IS NOT NULL AND is_active = TRUE;
CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicles_active_plate
  ON vehicles (coalesce(upper(plate_state), ''), upper(regexp_replace(plate_number, '[^A-Za-z0-9]', '', 'g')))
  WHERE is_active = TRUE;

-- ───────────────────────────────────────────────────────────────────────────
-- 13. Private storage bucket for driver documents
-- Uploads happen only through server-issued signed upload URLs; reads only
-- through short-lived signed URLs. No client storage policies on purpose.
-- ───────────────────────────────────────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'driver-docs', 'driver-docs', false, 15728640,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']
)
ON CONFLICT (id) DO NOTHING;

-- ───────────────────────────────────────────────────────────────────────────
-- 14. Fix provision_approved_driver: correct vehicle_class mapping + vehicle
--     compliance fields. (Original 012 version casts application tier values
--     like 'electric' directly to the economy/comfort/premium enum → error.)
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION provision_approved_driver(p_application_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  app_record RECORD;
  new_driver_id UUID;
  mapped_class vehicle_class;
BEGIN
  SELECT * INTO app_record FROM driver_applications
  WHERE id = p_application_id AND status = 'approved';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Application % not found or not approved', p_application_id;
  END IF;

  SELECT id INTO new_driver_id FROM drivers WHERE auth_user_id = app_record.user_id;

  IF new_driver_id IS NULL THEN
    INSERT INTO drivers (
      full_name, email, phone, license_number, status,
      is_verified, is_active, auth_user_id
    ) VALUES (
      app_record.full_name, app_record.email, app_record.phone,
      COALESCE(app_record.license_number, ''), 'offline',
      TRUE, TRUE, app_record.user_id
    ) RETURNING id INTO new_driver_id;
  ELSE
    UPDATE drivers SET is_verified = TRUE, is_active = TRUE, updated_at = now()
    WHERE id = new_driver_id;
  END IF;

  -- Map application service tiers onto the dispatch vehicle_class enum.
  mapped_class := CASE app_record.vehicle_class
    WHEN 'electric'         THEN 'economy'::vehicle_class
    WHEN 'comfort_electric' THEN 'comfort'::vehicle_class
    WHEN 'premium_electric' THEN 'premium'::vehicle_class
    WHEN 'suv_electric'     THEN 'premium'::vehicle_class
    ELSE 'economy'::vehicle_class
  END;

  IF app_record.vehicle_make IS NOT NULL AND app_record.plate_number IS NOT NULL THEN
    INSERT INTO vehicles (
      driver_id, vehicle_class, make, model, year, color, plate_number,
      capacity, is_active, vin, plate_state, doors, seatbelts, powertrain, body_type
    )
    SELECT
      new_driver_id, mapped_class, app_record.vehicle_make, app_record.vehicle_model,
      app_record.vehicle_year, app_record.vehicle_color, app_record.plate_number,
      COALESCE(app_record.seatbelts, 4), TRUE, app_record.vin, app_record.plate_state,
      app_record.doors, app_record.seatbelts, app_record.powertrain, app_record.body_type
    WHERE NOT EXISTS (
      SELECT 1 FROM vehicles v
      WHERE v.driver_id = new_driver_id AND v.is_active = TRUE
    );
  END IF;

  INSERT INTO driver_wallets (user_id)
  VALUES (app_record.user_id)
  ON CONFLICT (user_id) DO NOTHING;

  UPDATE driver_applications
  SET activated_at = COALESCE(activated_at, now()), updated_at = now()
  WHERE id = p_application_id;

  RETURN new_driver_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION provision_approved_driver(UUID) FROM anon, authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 15. Realtime: drivers see review/status updates live
-- ───────────────────────────────────────────────────────────────────────────
ALTER PUBLICATION supabase_realtime ADD TABLE public.application_requirements;
ALTER PUBLICATION supabase_realtime ADD TABLE public.driver_applications;

NOTIFY pgrst, 'reload schema';
