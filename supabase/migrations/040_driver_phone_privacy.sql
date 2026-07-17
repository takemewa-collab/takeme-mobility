-- ═══════════════════════════════════════════════════════════════════════════
-- 040 — Column-level privacy on drivers.
-- Clients can never read a driver's raw phone, email, license number, or
-- payout details, even for rows RLS lets them see (the assigned rider during
-- an active trip only needs name / photo / rating / vehicle). Server routes
-- use the service role and are unaffected.
-- ═══════════════════════════════════════════════════════════════════════════

REVOKE SELECT ON public.drivers FROM authenticated, anon;
GRANT SELECT (
  id, full_name, avatar_url, status, rating, total_trips,
  is_verified, is_active, created_at, updated_at, auth_user_id,
  accepts_pets, max_pet_size, pet_conditions
) ON public.drivers TO authenticated;
-- anon keeps no SELECT at all.
