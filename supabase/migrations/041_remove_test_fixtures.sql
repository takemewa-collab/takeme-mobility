-- ═══════════════════════════════════════════════════════════════════════════
-- 041 — Remove the pre-launch test fixtures from production.
-- Exactly one fixture driver ("Test Driver", created 2026-07-12, never
-- verified or active) plus its test vehicle and stale location row.
-- Historical cancelled rides are preserved; their dangling reference to the
-- fixture driver is nulled, statuses and timestamps untouched.
-- Guarded: deletes nothing unless the row still matches the fixture shape.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  fixture_driver UUID := '139bc0c2-d4c6-4f22-9633-6538232f8b29';
  fixture_vehicle UUID := 'a2d1b2f1-1ea6-475f-8704-793d1a7019fa';
BEGIN
  -- Abort silently if the driver row is not the expected inactive fixture.
  IF NOT EXISTS (
    SELECT 1 FROM drivers
    WHERE id = fixture_driver
      AND is_active = false
      AND is_verified = false
      AND full_name ILIKE '%test%'
  ) THEN
    RAISE NOTICE 'Fixture driver absent or no longer fixture-shaped; skipping.';
    RETURN;
  END IF;

  -- Preserve historical rides: null the fixture references only.
  UPDATE rides SET assigned_driver_id = NULL
    WHERE assigned_driver_id = fixture_driver;
  UPDATE rides SET vehicle_id = NULL
    WHERE vehicle_id = fixture_vehicle;

  DELETE FROM driver_locations WHERE driver_id = fixture_driver;
  DELETE FROM vehicles WHERE id = fixture_vehicle AND driver_id = fixture_driver;
  DELETE FROM drivers WHERE id = fixture_driver;
END $$;
