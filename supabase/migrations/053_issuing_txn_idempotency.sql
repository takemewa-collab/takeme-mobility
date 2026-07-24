-- ═══════════════════════════════════════════════════════════════════════════
-- 053 — Idempotent, atomic Issuing transaction settlement.
--
-- The issuing_transaction.created webhook did a read-modify-write on
-- takeme_cards.balance plus three separate inserts/updates with no unique
-- key on the Stripe transaction id: a mid-handler failure (which releases
-- the webhook dedup claim so Stripe retries) or a concurrent duplicate
-- delivery could deduct the balance or credit cashback twice.
--
-- apply_issuing_transaction makes the whole settlement one database
-- transaction keyed by the Stripe transaction id:
--   * card_transactions.stripe_txn_id + a partial unique index is the
--     idempotency claim — the first inserter wins, every replay returns
--     FALSE without touching balances (concurrent duplicates serialize on
--     the index and conflict after the winner commits);
--   * balance deduction is a single relative UPDATE (no read-modify-write,
--     so concurrent different transactions cannot lose updates);
--   * charge row, balance, driver_balances mirror, and cashback row all
--     commit or roll back together.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE card_transactions ADD COLUMN IF NOT EXISTS stripe_txn_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS one_card_txn_per_stripe_txn
  ON card_transactions (stripe_txn_id)
  WHERE stripe_txn_id IS NOT NULL;

CREATE OR REPLACE FUNCTION apply_issuing_transaction(
  p_stripe_txn_id TEXT,
  p_card_id UUID,
  p_user_id UUID,
  p_amount NUMERIC,
  p_cashback NUMERIC,
  p_merchant TEXT,
  p_category TEXT,
  p_cashback_description TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rows_inserted INTEGER;
BEGIN
  IF p_stripe_txn_id IS NULL OR length(p_stripe_txn_id) = 0 THEN
    RAISE EXCEPTION 'stripe_txn_id is required for idempotent settlement';
  END IF;
  IF p_amount < 0 OR p_cashback < 0 THEN
    RAISE EXCEPTION 'amounts must be non-negative';
  END IF;

  -- Idempotency claim: exactly one delivery settles this Stripe transaction.
  INSERT INTO card_transactions (card_id, user_id, type, amount, description, category, status, stripe_txn_id)
  VALUES (p_card_id, p_user_id, 'charge', p_amount, p_merchant, p_category, 'completed', p_stripe_txn_id)
  ON CONFLICT (stripe_txn_id) WHERE stripe_txn_id IS NOT NULL DO NOTHING;

  GET DIAGNOSTICS rows_inserted = ROW_COUNT;
  IF rows_inserted = 0 THEN
    RETURN FALSE; -- duplicate delivery — already settled, nothing mutated
  END IF;

  UPDATE takeme_cards
  SET balance = balance - p_amount,
      total_cashback = total_cashback + p_cashback,
      updated_at = now()
  WHERE id = p_card_id;

  PERFORM decrement_card_balance(p_user_id, p_amount);

  IF p_cashback > 0 THEN
    INSERT INTO card_transactions (card_id, user_id, type, amount, description, category, status)
    VALUES (
      p_card_id, p_user_id, 'cashback', p_cashback,
      COALESCE(p_cashback_description, 'Cashback: ' || COALESCE(p_merchant, 'purchase')),
      'cashback_reward', 'completed'
    );
  END IF;

  RETURN TRUE;
END;
$$;

REVOKE EXECUTE ON FUNCTION apply_issuing_transaction(TEXT, UUID, UUID, NUMERIC, NUMERIC, TEXT, TEXT, TEXT) FROM anon, authenticated;
