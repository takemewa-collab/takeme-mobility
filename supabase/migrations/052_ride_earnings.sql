-- ═══════════════════════════════════════════════════════════════════════════
-- 052 — Ride earnings credit.
--
-- Completing a trip captured the rider's payment but never credited the
-- driver's wallet: add_driver_earning existed yet nothing called it on
-- completion, so dashboards showed $0 forever and payouts had nothing to pay.
--
-- credit_ride_earning is the idempotent primitive both settlement paths
-- (driver complete API and the Stripe payment_intent.succeeded webhook) can
-- call safely: a partial unique index guarantees at most ONE ride_earning
-- transaction per ride, no matter how many times or from how many paths it
-- runs. Wallets are keyed by the auth user id (011/050).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE UNIQUE INDEX IF NOT EXISTS one_ride_earning_per_ride
  ON driver_transactions (ride_id)
  WHERE type = 'ride_earning' AND ride_id IS NOT NULL;

CREATE OR REPLACE FUNCTION credit_ride_earning(
  p_driver_user_id UUID,
  p_ride_id UUID,
  p_amount NUMERIC,
  p_description TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_available NUMERIC;
  rows_inserted INTEGER;
BEGIN
  IF p_amount <= 0 THEN
    RETURN FALSE;
  END IF;

  -- The transaction row is the idempotency claim: exactly one path wins.
  INSERT INTO driver_transactions (driver_id, type, amount, balance_after, description, ride_id, status)
  VALUES (p_driver_user_id, 'ride_earning', p_amount, 0, p_description, p_ride_id, 'completed')
  ON CONFLICT (ride_id) WHERE type = 'ride_earning' AND ride_id IS NOT NULL
  DO NOTHING;

  GET DIAGNOSTICS rows_inserted = ROW_COUNT;
  IF rows_inserted = 0 THEN
    RETURN FALSE;
  END IF;

  INSERT INTO driver_wallets (driver_id, available, lifetime)
  VALUES (p_driver_user_id, p_amount, p_amount)
  ON CONFLICT (driver_id) DO UPDATE SET
    available = driver_wallets.available + p_amount,
    lifetime  = driver_wallets.lifetime + p_amount,
    updated_at = now();

  SELECT available INTO new_available FROM driver_wallets WHERE driver_id = p_driver_user_id;

  UPDATE driver_transactions
  SET balance_after = new_available
  WHERE ride_id = p_ride_id AND type = 'ride_earning';

  RETURN TRUE;
END;
$$;

REVOKE EXECUTE ON FUNCTION credit_ride_earning(UUID, UUID, NUMERIC, TEXT) FROM anon, authenticated;
