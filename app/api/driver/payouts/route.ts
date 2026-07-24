import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createApiClient } from '@/lib/supabase/api';
import { createServiceClient } from '@/lib/supabase/service';
import {
  executeDriverPayout,
  getConnectAccountStatus,
  payoutConfigFromEnv,
  quotePayout,
  reconcilePayout,
} from '@/lib/driver-payouts';

// ═══════════════════════════════════════════════════════════════════════════
// GET  /api/driver/payouts — the driver's authoritative payout profile:
//      balance model, Connect/destination state, instant eligibility with an
//      exact non-sensitive reason when unavailable, fee schedule, history.
// POST /api/driver/payouts — execute a payout. The client sends ONLY
//      { amountUsd, speed, idempotencyKey }; every balance, fee, and
//      eligibility decision is recomputed server-side at execution time.
// ═══════════════════════════════════════════════════════════════════════════

async function resolveDriverUser(request: NextRequest) {
  const { user } = await createApiClient(request);
  if (!user) return null;
  const svc = createServiceClient();
  const { data: driver } = await svc
    .from('drivers')
    .select('id')
    .eq('auth_user_id', user.id)
    .maybeSingle();
  if (!driver) return null;
  return { userId: user.id, driverRowId: driver.id as string };
}

export async function GET(request: NextRequest) {
  try {
    const who = await resolveDriverUser(request);
    if (!who) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const svc = createServiceClient();
    const config = payoutConfigFromEnv();

    const { data: wallet } = await svc
      .from('driver_wallets')
      .select('available, pending, lifetime, card_balance, stripe_account_id')
      .eq('driver_id', who.userId)
      .maybeSingle();

    const { data: payouts } = await svc
      .from('driver_payouts')
      .select('id, driver_id, amount, fee, net, method, speed, status, destination_brand, destination_last4, expected_arrival, failure_reason, stripe_payout_id, created_at, completed_at')
      .eq('driver_id', who.userId)
      .order('created_at', { ascending: false })
      .limit(25);

    // Reconcile any in-flight payouts against Stripe (webhook safety net).
    const history = [] as NonNullable<typeof payouts>;
    for (const p of payouts ?? []) {
      if (p.status === 'in_transit' || (p.status === 'pending' && p.stripe_payout_id)) {
        p.status = await reconcilePayout({
          id: p.id as string,
          driver_id: p.driver_id as string,
          amount: Number(p.amount),
          status: p.status as string,
          stripe_payout_id: (p.stripe_payout_id as string | null) ?? null,
        });
      }
      history.push(p);
    }

    const inTransitUsd = history
      .filter((p) => p.status === 'pending' || p.status === 'in_transit')
      .reduce((s, p) => s + Number(p.amount), 0);
    const paidOutUsd = history
      .filter((p) => p.status === 'paid')
      .reduce((s, p) => s + Number(p.amount), 0);

    // Connect / destination state — only when an account exists. The Cash
    // Out surface stays in its disabled state (with the exact reason) until
    // real payout infrastructure is connected for this driver.
    let connect: {
      onboarded: boolean;
      payoutsEnabled: boolean;
      requirementsDue: string[];
      destinations: { id: string; kind: string; brandOrBank: string; last4: string; supportsInstant: boolean; isDefault: boolean }[];
      instantEligible: boolean;
      unavailableReason: string | null;
    };
    if (wallet?.stripe_account_id) {
      try {
        const status = await getConnectAccountStatus(wallet.stripe_account_id as string);
        const instantDest = status.externalAccounts.find((d) => d.supportsInstant);
        connect = {
          onboarded: status.detailsSubmitted,
          payoutsEnabled: status.payoutsEnabled,
          requirementsDue: status.requirementsDue,
          destinations: status.externalAccounts,
          instantEligible: status.payoutsEnabled && instantDest != null,
          unavailableReason: !status.detailsSubmitted
            ? 'Finish setting up your payout account.'
            : !status.payoutsEnabled
              ? 'Your payout account needs attention before payouts can resume.'
              : status.externalAccounts.length === 0
                ? 'Add a debit card or bank account to cash out.'
                : instantDest == null
                  ? 'Your destination does not support instant payouts — standard payouts are available.'
                  : null,
        };
      } catch {
        connect = {
          onboarded: true,
          payoutsEnabled: false,
          requirementsDue: [],
          destinations: [],
          instantEligible: false,
          unavailableReason: 'Payout status is temporarily unavailable.',
        };
      }
    } else {
      connect = {
        onboarded: false,
        payoutsEnabled: false,
        requirementsDue: [],
        destinations: [],
        instantEligible: false,
        unavailableReason: 'Set up your payout account to cash out your earnings.',
      };
    }

    const availableUsd = Number(wallet?.available ?? 0);
    return NextResponse.json({
      balances: {
        availableUsd,
        pendingUsd: Number(wallet?.pending ?? 0),
        lifetimeUsd: Number(wallet?.lifetime ?? 0),
        inTransitUsd,
        paidOutUsd,
        // Instant eligibility caps at the available balance; funds shown as
        // pending are NEVER withdrawable.
        instantAvailableUsd: connect.instantEligible ? availableUsd : 0,
      },
      fees: {
        instantFeePct: config.instantFeePct,
        instantFeeMinUsd: config.instantFeeMinUsd,
        minPayoutUsd: config.minPayoutUsd,
        dailyLimitUsd: config.dailyLimitUsd,
        standardFeeUsd: 0,
        // Stripe's language, not a promise: typically within 30 minutes.
        instantArrivalCopy: 'Typically arrives within 30 minutes',
        standardArrivalCopy: 'Arrives in 1–3 business days',
      },
      connect,
      history,
    });
  } catch (err) {
    console.error('GET /api/driver/payouts failed:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}

const executeSchema = z.object({
  amountUsd: z.number().positive().max(10000),
  speed: z.enum(['instant', 'standard']),
  /** Client-generated UUID — duplicate submissions return the same payout. */
  idempotencyKey: z.string().uuid(),
});

export async function POST(request: NextRequest) {
  try {
    const who = await resolveDriverUser(request);
    if (!who) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = executeSchema.parse(await request.json());

    // Preview the quote so even failures echo exact fee/net policy.
    const quote = quotePayout(body.amountUsd, body.speed, payoutConfigFromEnv());

    const result = await executeDriverPayout({
      userId: who.userId,
      amountUsd: body.amountUsd,
      speed: body.speed,
      clientKey: body.idempotencyKey,
    });

    return NextResponse.json(
      { ...result, quote },
      { status: result.ok || result.replayed ? 200 : 422 },
    );
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }
    console.error('POST /api/driver/payouts failed:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
