-- ═══════════════════════════════════════════════════════════════════════════
-- 038 — One active assignment per driver, guaranteed by the database.
-- Belt-and-braces on top of the optimistic lock in finalizeAssignment: two
-- concurrent acceptances can never both commit an active ride for the same
-- driver.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE UNIQUE INDEX IF NOT EXISTS one_active_ride_per_driver
  ON rides (assigned_driver_id)
  WHERE assigned_driver_id IS NOT NULL
    AND status IN ('driver_assigned', 'driver_arriving', 'arrived', 'in_progress');
