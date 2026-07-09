-- ═══════════════════════════════════════════════════════════════════════════
-- 033 — Atomic driver-wallet debit (SECURITY/DATA-INTEGRITY P0)
--
-- Problem: /api/driver/payouts/instant reads driver_wallets.available, checks
-- it in JS, then writes `available - amount` back. Two concurrent payouts (or a
-- client retry) both pass the check and both deduct → the driver is paid twice
-- while the wallet is debited once (or goes toward negative). The CHECK(available
-- >= 0) constraint does not catch this (40 >= 0 is still valid).
--
-- Fix: perform the debit as a single atomic UPDATE guarded by `available >=
-- amount`. Concurrent callers serialize on the row lock; the loser sees the
-- reduced balance and the WHERE no longer matches → FOUND is false → we raise.
--
-- Wire-up (apply this migration BEFORE deploying the route change):
--   card path:  svc.rpc('debit_driver_wallet', { p_driver_id: user.id,
--                        p_amount: amount, p_to_card: true })
--   bank path:  svc.rpc('debit_driver_wallet', { p_driver_id: user.id,
--                        p_amount: amount, p_to_card: false })  -- debit FIRST,
--               then Stripe transfer/payout with an Idempotency-Key; refund the
--               wallet (credit back) if Stripe throws.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.debit_driver_wallet(
  p_driver_id UUID,
  p_amount    NUMERIC,
  p_to_card   BOOLEAN DEFAULT FALSE
)
RETURNS NUMERIC   -- returns the new `available` balance
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  new_available NUMERIC;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;

  UPDATE public.driver_wallets
     SET available    = available - p_amount,
         card_balance = card_balance + (CASE WHEN p_to_card THEN p_amount ELSE 0 END),
         updated_at   = now()
   WHERE driver_id = p_driver_id
     AND available >= p_amount
  RETURNING available INTO new_available;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INSUFFICIENT_FUNDS';
  END IF;

  RETURN new_available;
END;
$$;

-- Only the backend (service role) should call this.
REVOKE ALL ON FUNCTION public.debit_driver_wallet(UUID, NUMERIC, BOOLEAN) FROM public, anon, authenticated;
