-- 036 — Rider credit ledger (TAKEME Credit)
--
-- A simple append-only ledger backing the Wallet's TAKEME Credit balance:
-- top-ups (Stripe-confirmed), refunds, promotional credits, gifts, and ride
-- debits. Balance = sum(amount_cents). Riders can read their own entries;
-- every write goes through the service role (API routes), never the client.

create table if not exists public.rider_credit_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  amount_cents integer not null,
  kind text not null check (kind in ('topup', 'refund', 'promo', 'gift', 'ride_debit')),
  note text,
  -- Set for top-ups; unique so a retried confirm can never double-credit.
  stripe_payment_intent_id text unique,
  created_at timestamptz not null default now()
);

create index if not exists rider_credit_ledger_user_idx
  on public.rider_credit_ledger (user_id, created_at desc);

alter table public.rider_credit_ledger enable row level security;

-- Read your own entries (app_user_id() resolves both native and Clerk JWTs).
drop policy if exists rider_credit_ledger_select_own on public.rider_credit_ledger;
create policy rider_credit_ledger_select_own
  on public.rider_credit_ledger
  for select
  using (user_id = public.app_user_id());

-- No insert/update/delete policies: client writes are impossible by design.
