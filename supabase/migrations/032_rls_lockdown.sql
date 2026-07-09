-- ═══════════════════════════════════════════════════════════════════════════
-- 032 — RLS lockdown (SECURITY P0)
--
-- Problem: several migrations created blanket policies of the form
--   CREATE POLICY "..._all" ON <table> FOR ALL USING (true) WITH CHECK (true);
-- with NO `TO service_role` qualifier. An unqualified policy applies to PUBLIC
-- (anon + authenticated). Because RLS policies are permissive (OR'd together),
-- each of these overrides every carefully-scoped *_select_own / *_update_own
-- policy on the same table. Consequences (all via the public anon key + a user
-- JWT, hitting PostgREST directly):
--   • A rider can PATCH /rest/v1/riders?id=eq.<self> with {"is_admin":true}
--     and become an admin (privilege escalation).
--   • Any authenticated user can SELECT every rider/profile row (email, phone…),
--     and read/write all fleet owner PII, payouts, contracts, bookings.
--
-- service_role already has the BYPASSRLS attribute, so these blanket policies
-- are UNNECESSARY for the backend and only serve to open the tables to clients.
-- This migration removes them and adds a trigger that freezes the privileged
-- columns (is_admin / role) against non-service writers.
--
-- NOTE: apply on a branch/staging DB and smoke-test client reads before prod.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Drop dangerous PUBLIC "FOR ALL USING(true)" policies ────────────────
-- (service_role bypasses RLS, so backend access is unaffected.)

DROP POLICY IF EXISTS "riders_service_all"        ON public.riders;
DROP POLICY IF EXISTS "profiles_service_all"      ON public.profiles;

DROP POLICY IF EXISTS "inv_violations_all"        ON public.invariant_violations;
DROP POLICY IF EXISTS "inv_metrics_all"           ON public.invariant_metrics_log;
DROP POLICY IF EXISTS "simulation_logs_all"       ON public.simulation_logs;
DROP POLICY IF EXISTS "payment_audit_log_all"     ON public.payment_audit_log;
DROP POLICY IF EXISTS "invariant_check_log_all"   ON public.invariant_check_log;
DROP POLICY IF EXISTS "failed_emails_all"         ON public.failed_emails;

-- Fleet system created "fleet_<table>_all" blanket policies in a loop (026).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'fleet_owners','fleet_vehicles','vehicle_documents','vehicle_photos',
    'vehicle_availability','vehicle_pricing_rules','contract_templates','contracts',
    'contract_signers','contract_signature_events','contract_audit_events',
    'driver_rental_profiles','driver_rental_eligibility','rental_bookings',
    'rental_booking_status_history','rental_checkout_sessions','security_deposits',
    'vehicle_handoffs','vehicle_return_reports','damage_reports',
    'fleet_commissions','fleet_payouts','payout_line_items',
    'fleet_risk_events','fleet_invariant_violations'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "fleet_%s_all" ON public.%I', t, t);
  END LOOP;
END $$;

-- ── 2. Restrict profiles reads to authenticated users ──────────────────────
-- Previously "profiles_select_all" used USING(true) → readable by anon.
-- profiles holds full_name + phone (PII); require a session at minimum.
DROP POLICY IF EXISTS "profiles_select_all" ON public.profiles;
CREATE POLICY "profiles_select_authenticated" ON public.profiles
  FOR SELECT TO authenticated USING (true);

-- ── 3. Freeze privileged rider columns against self-escalation ─────────────
-- riders_update_own only checks auth.uid() = id, which does NOT stop a user
-- from flipping their own is_admin/role. Enforce it in a trigger that runs for
-- every non-BYPASSRLS writer.
CREATE OR REPLACE FUNCTION public.freeze_rider_privileged_columns()
RETURNS TRIGGER AS $$
DECLARE
  claims text;
  claim_role text;
BEGIN
  -- IMPORTANT: BYPASSRLS does NOT bypass triggers, so this fires for the
  -- backend too. The service client authenticates to PostgREST as
  -- role 'service_role' — allow it (and direct postgres, which has no claims)
  -- to manage these columns. Freeze them only for anon/authenticated writers.
  claims := current_setting('request.jwt.claims', true);
  IF claims IS NULL OR claims = '' THEN
    RETURN NEW; -- direct server-side connection (no PostgREST JWT) — allow
  END IF;

  claim_role := claims::json->>'role';
  IF claim_role = 'service_role' THEN
    RETURN NEW; -- backend via service key — allow
  END IF;

  -- anon / authenticated: privileged columns cannot change.
  NEW.is_admin := OLD.is_admin;
  NEW.role     := OLD.role;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_freeze_rider_privileged ON public.riders;
CREATE TRIGGER trg_freeze_rider_privileged
  BEFORE UPDATE ON public.riders
  FOR EACH ROW EXECUTE FUNCTION public.freeze_rider_privileged_columns();

-- Refresh PostgREST schema cache
NOTIFY pgrst, 'reload schema';
