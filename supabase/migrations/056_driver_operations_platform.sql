-- ═══════════════════════════════════════════════════════════════════════════
-- 056: Driver operations platform — status history (online hours),
--      notifications, payout ledger extensions, incentive programs.
--
-- Design rules:
--  * All financial truth lives in immutable ledger rows (driver_transactions,
--    driver_payouts); balances derive from them plus driver_wallets.
--  * Clients never write any of these tables — service role only. Driver
--    reads are RLS-scoped through public.app_user_id() (Clerk-safe, 035).
--  * No fabricated data: notifications/incentives tables start EMPTY and are
--    populated only by real production events / real configured programs.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Driver status history — raw material for online hours ─────────────
-- PUT /api/driver/status appends a row per transition. Online time =
-- intervals between consecutive rows where status <> 'offline'. History
-- starts accumulating at deploy time; the API returns null (never 0) for
-- periods before tracking existed.

CREATE TABLE IF NOT EXISTS driver_status_history (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  driver_id     UUID NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  status        driver_status NOT NULL,
  effective_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dsh_driver_time
  ON driver_status_history(driver_id, effective_at DESC);

ALTER TABLE driver_status_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "dsh_select_own" ON driver_status_history FOR SELECT
  USING (driver_id = public.get_driver_id());

-- ── 2. Driver notifications — real backend events only ───────────────────

CREATE TABLE IF NOT EXISTS driver_notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  category    TEXT NOT NULL CHECK (category IN
                ('earnings','payout','document','compliance','ride','safety','schedule','promotion')),
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  data        JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_dnotif_user_time
  ON driver_notifications(user_id, created_at DESC);

ALTER TABLE driver_notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "dnotif_select_own" ON driver_notifications FOR SELECT
  USING (user_id = public.app_user_id());
-- Drivers may only flip read_at; column-level grant enforces that.
CREATE POLICY "dnotif_update_own" ON driver_notifications FOR UPDATE
  USING (user_id = public.app_user_id())
  WITH CHECK (user_id = public.app_user_id());
REVOKE UPDATE ON driver_notifications FROM anon, authenticated;
GRANT UPDATE (read_at) ON driver_notifications TO authenticated;

-- ── 3. Payout ledger extensions ───────────────────────────────────────────
-- fee/net/speed/destination/arrival make every historical payout fully
-- explainable in the app without calling Stripe; idempotency_key makes
-- retried requests return the original payout instead of double-paying.

ALTER TABLE driver_payouts
  ADD COLUMN IF NOT EXISTS fee               NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS net               NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS speed             TEXT CHECK (speed IN ('instant','standard')),
  ADD COLUMN IF NOT EXISTS destination_brand TEXT,
  ADD COLUMN IF NOT EXISTS destination_last4 TEXT,
  ADD COLUMN IF NOT EXISTS expected_arrival  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS idempotency_key   TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS one_payout_per_idempotency_key
  ON driver_payouts(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Double-click shield beyond the idempotency key: at most ONE external
-- payout may sit in 'pending' (creation window) per driver. 'in_transit'
-- payouts are deliberately NOT blocked — the wallet was already atomically
-- debited, so concurrent in-flight payouts cannot double-spend.
CREATE UNIQUE INDEX IF NOT EXISTS one_creating_external_payout_per_driver
  ON driver_payouts(driver_id)
  WHERE status = 'pending' AND method IN ('bank','debit');

-- ── 4. Incentive programs — model only; rows come from real config ────────

CREATE TABLE IF NOT EXISTS incentive_programs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_key TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  description TEXT NOT NULL,
  program_type TEXT NOT NULL CHECK (program_type IN
                ('ride_count_goal','time_window_bonus','geo_bonus','referral')),
  config      JSONB NOT NULL DEFAULT '{}',
  starts_at   TIMESTAMPTZ NOT NULL,
  ends_at     TIMESTAMPTZ NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

CREATE TABLE IF NOT EXISTS driver_incentive_progress (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id   UUID NOT NULL REFERENCES incentive_programs(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  progress     JSONB NOT NULL DEFAULT '{}',
  earned_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN
                 ('in_progress','completed','paid','expired')),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (program_id, user_id)
);

ALTER TABLE incentive_programs ENABLE ROW LEVEL SECURITY;
ALTER TABLE driver_incentive_progress ENABLE ROW LEVEL SECURITY;
-- Active programs are visible to any authenticated driver; progress is own-only.
CREATE POLICY "incentive_programs_select_active" ON incentive_programs FOR SELECT
  USING (is_active = true);
CREATE POLICY "incentive_progress_select_own" ON driver_incentive_progress FOR SELECT
  USING (user_id = public.app_user_id());

-- ── 5. Wire the atomic wallet debit into payouts ──────────────────────────
-- debit_driver_wallet (033) already exists and is service-role-only; no
-- schema change needed here — the payout route now calls it debit-FIRST.
