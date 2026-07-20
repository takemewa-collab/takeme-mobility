-- ═══════════════════════════════════════════════════════════════════════════
-- 049 — Staged applications
-- The activation platform (047) collects vehicle identity in a later step
-- than the legacy single-blob apply flow, so the vehicle columns can no
-- longer be NOT NULL at insert time. Vehicle presence is enforced by the
-- requirements engine (vehicle_details requirement), not the schema.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE driver_applications
  ALTER COLUMN vehicle_make DROP NOT NULL,
  ALTER COLUMN vehicle_model DROP NOT NULL,
  ALTER COLUMN plate_number DROP NOT NULL;

NOTIFY pgrst, 'reload schema';
