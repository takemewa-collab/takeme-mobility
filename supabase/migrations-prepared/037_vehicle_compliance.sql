-- ═══════════════════════════════════════════════════════════════════════════
-- 037 — Vehicle compliance & driver documents
-- PREPARED, not yet applied: apply together with the onboarding-documents
-- feature (Phase 3). No code depends on this schema yet.
-- ═══════════════════════════════════════════════════════════════════════════

-- Compliance status enums as CHECKed text (cheap to extend, no enum churn).
ALTER TABLE vehicles
  ADD COLUMN IF NOT EXISTS registration_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (registration_status IN ('pending', 'valid', 'expired', 'rejected')),
  ADD COLUMN IF NOT EXISTS insurance_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (insurance_status IN ('pending', 'valid', 'expired', 'rejected')),
  ADD COLUMN IF NOT EXISTS inspection_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (inspection_status IN ('pending', 'valid', 'expired', 'rejected')),
  ADD COLUMN IF NOT EXISTS photo_url TEXT;

-- Driver-uploaded compliance documents (stored in the private driver-docs
-- bucket; this table is the review ledger).
CREATE TABLE IF NOT EXISTS driver_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id UUID NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN (
    'license_front', 'license_back', 'insurance', 'registration',
    'inspection', 'profile_photo', 'vehicle_photo'
  )),
  storage_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted', 'approved', 'rejected')),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE driver_documents ENABLE ROW LEVEL SECURITY;

-- Drivers see and submit only their own documents; review is service-role.
CREATE POLICY driver_documents_select_own ON driver_documents FOR SELECT
  TO authenticated
  USING (EXISTS (
    SELECT 1 FROM drivers
    WHERE drivers.id = driver_documents.driver_id
      AND drivers.auth_user_id = (SELECT app_user_id())
  ));

CREATE POLICY driver_documents_insert_own ON driver_documents FOR INSERT
  TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM drivers
    WHERE drivers.id = driver_documents.driver_id
      AND drivers.auth_user_id = (SELECT app_user_id())
  ));
