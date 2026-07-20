-- ═══════════════════════════════════════════════════════════════════════════
-- 051 — One open application per identity
-- The staged onboarding flow creates applications idempotently in code; this
-- makes the invariant a database guarantee so a race (double-tap, retry,
-- concurrent sessions) can never mint two live applications for one user —
-- and a returning phone identity can never accumulate parallel records.
-- Verified: no existing rows violate this (table audited before apply).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE UNIQUE INDEX IF NOT EXISTS idx_driver_applications_one_open
  ON driver_applications(user_id)
  WHERE status IN ('in_progress', 'pending');
