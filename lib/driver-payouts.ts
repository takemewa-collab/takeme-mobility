// ═══════════════════════════════════════════════════════════════════════════
// TAKEME MOBILITY — Driver Payouts (Stripe Connect Express)
//
// The complete production payout engine:
//   onboarding  → Express account per driver (payout schedule MANUAL so the
//                 platform controls every payout), account links for KYC and
//                 for changing the payout destination.
//   eligibility → derived ONLY from Stripe account state (payouts_enabled,
//                 external account available_payout_methods) and the wallet.
//   execution   → debit-FIRST via the atomic debit_driver_wallet RPC, then
//                 transfer (platform → connected) and payout (connected →
//                 external), each with Stripe idempotency keys derived from
//                 the payout row id. Any Stripe failure refunds the wallet
//                 and marks the payout failed with a sanitized reason.
//   truth       → the driver_payouts row + driver_transactions ledger are
//                 authoritative; webhooks (payout.paid/failed) and a
//                 reconcile-on-read pass converge them with Stripe.
//
// Client input is never trusted for balances, fees, or eligibility; the
// client supplies only (amount, speed, idempotency key).
// ═══════════════════════════════════════════════════════════════════════════

import { createServiceClient } from '@/lib/supabase/service';
import { stripeRequest } from '@/lib/stripe';
import {
  payoutConfigFromEnv,
  quotePayout,
  sanitizeStripeFailure,
  toCents,
  validatePayoutRequest,
} from '@/lib/driver-payout-policy';

export {
  payoutConfigFromEnv,
  quotePayout,
  sanitizeStripeFailure,
  toCents,
  centsToUsd,
  instantFeeUsd,
  validatePayoutRequest,
} from '@/lib/driver-payout-policy';
export type { PayoutConfig, PayoutQuote, PayoutRejection } from '@/lib/driver-payout-policy';

const STRIPE_API = 'https://api.stripe.com/v1';

// ── Stripe Connect plumbing (connected-account calls need the header) ─────

async function stripeConnectRequest(
  path: string,
  params: Record<string, string>,
  stripeAccountId: string,
  idempotencyKey?: string,
): Promise<Record<string, unknown>> {
  const key = process.env.STRIPE_SECRET_KEY ?? '';
  if (!key) throw new Error('STRIPE_SECRET_KEY not configured');
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/x-www-form-urlencoded',
    'Stripe-Account': stripeAccountId,
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: 'POST',
    headers,
    body: new URLSearchParams(params).toString(),
  });
  const data = await res.json();
  if (!res.ok) {
    const err = (data as { error?: { message?: string; code?: string } })?.error;
    const e = new Error(err?.message || `Stripe error ${res.status}`);
    (e as Error & { stripeCode?: string }).stripeCode = err?.code;
    throw e;
  }
  return data as Record<string, unknown>;
}

async function stripeConnectGet(path: string, stripeAccountId?: string): Promise<Record<string, unknown>> {
  const key = process.env.STRIPE_SECRET_KEY ?? '';
  if (!key) throw new Error('STRIPE_SECRET_KEY not configured');
  const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
  if (stripeAccountId) headers['Stripe-Account'] = stripeAccountId;
  const res = await fetch(`${STRIPE_API}${path}`, { headers });
  const data = await res.json();
  if (!res.ok) {
    const msg = (data as { error?: { message?: string } })?.error?.message || `Stripe error ${res.status}`;
    throw new Error(msg);
  }
  return data as Record<string, unknown>;
}

// ── Connect account lifecycle ─────────────────────────────────────────────

/**
 * The driver's Express account id, creating the account on first use.
 * Payout schedule is MANUAL — funds transferred in stay put until the
 * platform explicitly pays them out (otherwise Stripe would auto-sweep
 * daily and our instant/standard choice would be meaningless).
 */
export async function getOrCreateConnectAccount(userId: string): Promise<string> {
  const svc = createServiceClient();
  const { data: wallet } = await svc
    .from('driver_wallets')
    .select('stripe_account_id')
    .eq('driver_id', userId)
    .maybeSingle();
  if (wallet?.stripe_account_id) return wallet.stripe_account_id as string;

  const account = await stripeRequest(
    '/accounts',
    {
      type: 'express',
      country: 'US',
      'capabilities[transfers][requested]': 'true',
      business_type: 'individual',
      'settings[payouts][schedule][interval]': 'manual',
      'metadata[platform]': 'takeme_driver',
      'metadata[driver_user_id]': userId,
    },
    'POST',
    `acct_driver_${userId}`,
  );

  const accountId = account.id as string;
  // Upsert — the wallet row may not exist for a driver who has never earned.
  await svc.from('driver_wallets').upsert(
    { driver_id: userId, stripe_account_id: accountId },
    { onConflict: 'driver_id' },
  );
  return accountId;
}

export async function createOnboardingLink(accountId: string): Promise<string> {
  const base = 'https://www.takememobility.com';
  const link = await stripeRequest('/account_links', {
    account: accountId,
    type: 'account_onboarding',
    refresh_url: `${base}/driver/connect/refresh`,
    return_url: `${base}/driver/connect/return`,
  });
  return link.url as string;
}

/** Express dashboard login link — where the driver manages payout destinations. */
export async function createExpressLoginLink(accountId: string): Promise<string> {
  const link = await stripeRequest(`/accounts/${accountId}/login_links`, {});
  return link.url as string;
}

export interface ExternalAccountSummary {
  id: string;
  kind: 'card' | 'bank_account';
  brandOrBank: string;
  last4: string;
  supportsInstant: boolean;
  isDefault: boolean;
}

export interface ConnectAccountStatus {
  accountId: string;
  detailsSubmitted: boolean;
  payoutsEnabled: boolean;
  /** Non-sensitive requirement keys Stripe still needs (e.g. onboarding). */
  requirementsDue: string[];
  disabledReason: string | null;
  externalAccounts: ExternalAccountSummary[];
}

export async function getConnectAccountStatus(accountId: string): Promise<ConnectAccountStatus> {
  const account = await stripeConnectGet(`/accounts/${accountId}`);
  const requirements = (account.requirements ?? {}) as {
    currently_due?: string[];
    disabled_reason?: string | null;
  };
  const ext = ((account.external_accounts as { data?: Record<string, unknown>[] })?.data ?? []).map(
    (ea): ExternalAccountSummary => {
      const kind = ea.object === 'card' ? 'card' : 'bank_account';
      return {
        id: ea.id as string,
        kind,
        brandOrBank:
          kind === 'card' ? String(ea.brand ?? 'Card') : String(ea.bank_name ?? 'Bank account'),
        last4: String(ea.last4 ?? ''),
        supportsInstant: Array.isArray(ea.available_payout_methods)
          ? (ea.available_payout_methods as string[]).includes('instant')
          : false,
        isDefault: ea.default_for_currency === true,
      };
    },
  );
  return {
    accountId,
    detailsSubmitted: account.details_submitted === true,
    payoutsEnabled: account.payouts_enabled === true,
    requirementsDue: requirements.currently_due ?? [],
    disabledReason: requirements.disabled_reason ?? null,
    externalAccounts: ext,
  };
}

// ── Payout execution ──────────────────────────────────────────────────────

export interface ExecutePayoutResult {
  ok: boolean;
  payoutId: string;
  status: string;
  amountUsd: number;
  feeUsd: number;
  netUsd: number;
  expectedArrival: string | null;
  failureReason: string | null;
  /** True when this call found an existing payout for the idempotency key. */
  replayed: boolean;
}

/**
 * Execute a driver payout. Idempotent on `clientKey`: a duplicate tap or a
 * retried request returns the original payout row untouched.
 *
 * Order of operations is deliberate:
 *   1. claim the idempotency key by inserting the payout row (pending)
 *   2. atomically debit the wallet (insufficient funds → clean failure)
 *   3. transfer NET to the connected account, payout NET to the destination
 *   4. mark in_transit (webhooks/reconcile move it to paid/failed)
 * A Stripe failure after the debit refunds the wallet via the ledger
 * (type=adjustment) and marks the payout failed — never a silent hold.
 */
export async function executeDriverPayout(input: {
  userId: string;
  amountUsd: number;
  speed: 'instant' | 'standard';
  clientKey: string;
  destinationId?: string;
}): Promise<ExecutePayoutResult> {
  const svc = createServiceClient();
  const config = payoutConfigFromEnv();
  const quote = quotePayout(input.amountUsd, input.speed, config);
  const method = input.speed === 'instant' ? 'debit' : 'bank';

  // 0. Fresh authoritative state.
  const { data: wallet } = await svc
    .from('driver_wallets')
    .select('available, stripe_account_id')
    .eq('driver_id', input.userId)
    .maybeSingle();
  if (!wallet?.stripe_account_id) {
    return failResult('no_connect_account', 'Set up your payout account first.');
  }
  const accountId = wallet.stripe_account_id as string;

  const status = await getConnectAccountStatus(accountId);
  if (!status.payoutsEnabled) {
    return failResult(
      'payouts_disabled',
      status.requirementsDue.length > 0
        ? 'Your payout account setup is incomplete.'
        : 'Payouts are currently unavailable for your account.',
    );
  }
  const destination =
    (input.destinationId
      ? status.externalAccounts.find((ea) => ea.id === input.destinationId)
      : null) ??
    status.externalAccounts.find((ea) => ea.isDefault) ??
    status.externalAccounts[0];
  if (!destination) {
    return failResult('no_destination', 'Add a debit card or bank account first.');
  }
  if (input.speed === 'instant' && !destination.supportsInstant) {
    return failResult(
      'instant_unsupported',
      'This destination does not support instant payouts. Use a standard payout instead.',
    );
  }

  const { data: recent } = await svc
    .from('driver_payouts')
    .select('amount')
    .eq('driver_id', input.userId)
    .in('status', ['pending', 'in_transit', 'paid'])
    .in('method', ['bank', 'debit'])
    .gte('created_at', new Date(Date.now() - 24 * 3600 * 1000).toISOString());
  const paidOutLast24hUsd = (recent ?? []).reduce((s, p) => s + Number(p.amount), 0);

  const validation = validatePayoutRequest({
    amountUsd: input.amountUsd,
    availableUsd: Number(wallet.available ?? 0),
    paidOutLast24hUsd,
    quote,
    config,
  });
  if (validation.ok !== true) {
    return failResult(validation.code.toLowerCase(), validation.message);
  }

  // 1. Claim the idempotency key.
  const { data: inserted, error: insertError } = await svc
    .from('driver_payouts')
    .insert({
      driver_id: input.userId,
      amount: quote.amountUsd,
      fee: quote.feeUsd,
      net: quote.netUsd,
      method,
      speed: input.speed,
      status: 'pending',
      destination_brand: destination.brandOrBank,
      destination_last4: destination.last4,
      idempotency_key: input.clientKey,
    })
    .select('id')
    .single();

  if (insertError) {
    // Duplicate idempotency key or the one-pending-payout guard: return the
    // existing payout instead of creating another.
    const { data: existing } = await svc
      .from('driver_payouts')
      .select('id, status, amount, fee, net, expected_arrival, failure_reason')
      .eq('driver_id', input.userId)
      .eq('idempotency_key', input.clientKey)
      .maybeSingle();
    if (existing) {
      return {
        ok: existing.status !== 'failed',
        payoutId: existing.id as string,
        status: existing.status as string,
        amountUsd: Number(existing.amount),
        feeUsd: Number(existing.fee ?? 0),
        netUsd: Number(existing.net ?? existing.amount),
        expectedArrival: (existing.expected_arrival as string | null) ?? null,
        failureReason: (existing.failure_reason as string | null) ?? null,
        replayed: true,
      };
    }
    return failResult('payout_in_progress', 'A payout is already being processed. Check your payout history.');
  }
  const payoutId = inserted.id as string;

  // 2. Debit-first, atomically (033's RPC — guarded UPDATE, raises on shortfall).
  const { error: debitError } = await svc.rpc('debit_driver_wallet', {
    p_driver_id: input.userId,
    p_amount: quote.amountUsd,
    p_to_card: false,
  });
  if (debitError) {
    const reason = debitError.message?.includes('INSUFFICIENT_FUNDS')
      ? 'Amount exceeds your available balance.'
      : 'Could not reserve funds. Try again.';
    await markPayoutFailed(payoutId, reason);
    return failResult('debit_failed', reason, payoutId);
  }

  // Ledger row for the withdrawal (gross).
  const { data: walletAfter } = await svc
    .from('driver_wallets')
    .select('available')
    .eq('driver_id', input.userId)
    .single();
  await svc.from('driver_transactions').insert({
    driver_id: input.userId,
    type: 'payout',
    amount: -quote.amountUsd,
    balance_after: Number(walletAfter?.available ?? 0),
    description:
      input.speed === 'instant'
        ? `Instant payout to ${destination.brandOrBank} ••${destination.last4}`
        : `Payout to ${destination.brandOrBank} ••${destination.last4}`,
    status: 'completed',
  });

  // 3. Stripe: transfer NET to the connected account, then payout NET out.
  //    The fee stays on the platform (it covers Stripe's instant-payout fee).
  try {
    const transfer = await stripeRequest(
      '/transfers',
      {
        amount: String(toCents(quote.netUsd)),
        currency: 'usd',
        destination: accountId,
        description: `TAKEME payout ${payoutId}`,
        'metadata[payout_id]': payoutId,
      },
      'POST',
      `tr_${payoutId}`,
    );

    const payout = await stripeConnectRequest(
      '/payouts',
      {
        amount: String(toCents(quote.netUsd)),
        currency: 'usd',
        method: input.speed,
        ...(destination.id ? { destination: destination.id } : {}),
        'metadata[payout_id]': payoutId,
        'metadata[driver_user_id]': input.userId,
      },
      accountId,
      `po_${payoutId}`,
    );

    // Instant: Stripe says typically within 30 minutes (never guaranteed).
    // Standard: Stripe reports the arrival date.
    const arrivalDate = payout.arrival_date
      ? new Date(Number(payout.arrival_date) * 1000).toISOString()
      : null;
    const expectedArrival =
      input.speed === 'instant'
        ? new Date(Date.now() + 30 * 60 * 1000).toISOString()
        : arrivalDate;

    await svc
      .from('driver_payouts')
      .update({
        status: 'in_transit',
        stripe_transfer_id: transfer.id as string,
        stripe_payout_id: payout.id as string,
        expected_arrival: expectedArrival,
        initiated_at: new Date().toISOString(),
      })
      .eq('id', payoutId);

    await notifyDriver(input.userId, {
      category: 'payout',
      title: input.speed === 'instant' ? 'Instant payout on the way' : 'Payout on the way',
      body: `$${quote.netUsd.toFixed(2)} to ${destination.brandOrBank} ••${destination.last4}.`,
      data: { payoutId },
    });

    return {
      ok: true,
      payoutId,
      status: 'in_transit',
      amountUsd: quote.amountUsd,
      feeUsd: quote.feeUsd,
      netUsd: quote.netUsd,
      expectedArrival,
      failureReason: null,
      replayed: false,
    };
  } catch (err) {
    // 4. Refund the wallet — the money must never vanish into a failed payout.
    const message = sanitizeStripeFailure(err);
    await svc.rpc('add_driver_earning', {
      p_driver_id: input.userId,
      p_amount: quote.amountUsd,
      p_type: 'adjustment',
      p_description: 'Payout failed — funds returned',
      p_ride_id: null,
    });
    await markPayoutFailed(payoutId, message);
    await notifyDriver(input.userId, {
      category: 'payout',
      title: 'Payout failed',
      body: `${message} Your $${quote.amountUsd.toFixed(2)} was returned to your balance.`,
      data: { payoutId },
    });
    return failResult('stripe_failed', message, payoutId);
  }

  function failResult(code: string, message: string, id: string = ''): ExecutePayoutResult {
    return {
      ok: false,
      payoutId: id,
      status: 'failed',
      amountUsd: quote.amountUsd,
      feeUsd: quote.feeUsd,
      netUsd: quote.netUsd,
      expectedArrival: null,
      failureReason: message,
      replayed: false,
    };
  }
}

async function markPayoutFailed(payoutId: string, reason: string): Promise<void> {
  const svc = createServiceClient();
  await svc
    .from('driver_payouts')
    .update({ status: 'failed', failure_reason: reason, completed_at: new Date().toISOString() })
    .eq('id', payoutId)
    .neq('status', 'failed');
}

export async function notifyDriver(
  userId: string,
  n: { category: string; title: string; body: string; data?: Record<string, unknown> },
): Promise<void> {
  try {
    const svc = createServiceClient();
    await svc.from('driver_notifications').insert({
      user_id: userId,
      category: n.category,
      title: n.title,
      body: n.body,
      data: n.data ?? {},
    });
  } catch (err) {
    console.error('[driver-payouts] notification insert failed:', err);
  }
}

/**
 * Reconcile a payout row against Stripe — the safety net when Connect
 * webhooks are not configured/delivered. Called for in_transit payouts on
 * profile/history reads.
 */
export async function reconcilePayout(row: {
  id: string;
  driver_id: string;
  amount: number | string;
  status: string;
  stripe_payout_id: string | null;
}): Promise<string> {
  if (!row.stripe_payout_id || (row.status !== 'in_transit' && row.status !== 'pending')) {
    return row.status;
  }
  const svc = createServiceClient();
  const { data: wallet } = await svc
    .from('driver_wallets')
    .select('stripe_account_id')
    .eq('driver_id', row.driver_id)
    .maybeSingle();
  if (!wallet?.stripe_account_id) return row.status;

  try {
    const payout = await stripeConnectGet(
      `/payouts/${row.stripe_payout_id}`,
      wallet.stripe_account_id as string,
    );
    const stripeStatus = String(payout.status);
    if (stripeStatus === 'paid') {
      await svc
        .from('driver_payouts')
        .update({ status: 'paid', completed_at: new Date().toISOString() })
        .eq('id', row.id)
        .neq('status', 'paid');
      return 'paid';
    }
    if (stripeStatus === 'failed' || stripeStatus === 'canceled') {
      // Guarded transition so webhook + reconcile can never double-refund.
      const { data: flipped } = await svc
        .from('driver_payouts')
        .update({
          status: 'failed',
          failure_reason: String(payout.failure_message ?? 'The payout could not be completed.'),
          completed_at: new Date().toISOString(),
        })
        .eq('id', row.id)
        .in('status', ['pending', 'in_transit'])
        .select('id');
      if (flipped && flipped.length > 0) {
        await svc.rpc('add_driver_earning', {
          p_driver_id: row.driver_id,
          p_amount: Number(row.amount),
          p_type: 'adjustment',
          p_description: 'Payout failed — funds returned',
          p_ride_id: null,
        });
        await notifyDriver(row.driver_id, {
          category: 'payout',
          title: 'Payout failed',
          body: `Your $${Number(row.amount).toFixed(2)} was returned to your balance.`,
          data: { payoutId: row.id },
        });
      }
      return 'failed';
    }
  } catch (err) {
    console.error('[driver-payouts] reconcile failed:', err);
  }
  return row.status;
}
