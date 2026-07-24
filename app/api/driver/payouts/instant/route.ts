import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/driver/payouts/instant
//
// Instant payout from driver wallet.
// - TAKEME Card: moves funds to card_balance (instant)
// - Bank/Debit: creates Stripe Connect payout (requires Connect account)
// ═══════════════════════════════════════════════════════════════════════════

const schema = z.object({
  amount: z.number().positive().max(10000),
  method: z.enum(['takeme_card', 'bank', 'debit']).default('takeme_card'),
});

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });

    const body = schema.parse(await request.json());
    const svc = createServiceClient();

    // Get wallet
    const { data: wallet } = await svc
      .from('driver_wallets')
      .select('available, card_balance, stripe_account_id')
      .eq('driver_id', user.id)
      .single();

    if (!wallet) {
      return NextResponse.json({ error: 'No wallet found. Complete a ride first.' }, { status: 404 });
    }

    if (Number(wallet.available) < body.amount) {
      return NextResponse.json({
        error: `Insufficient balance. Available: $${Number(wallet.available).toFixed(2)}`,
      }, { status: 400 });
    }

    const now = new Date().toISOString();
    let payoutId: string | null = null;
    let transferId: string | null = null;

    if (body.method === 'takeme_card') {
      // Instant: move to card balance ATOMICALLY (033's guarded single-UPDATE
      // RPC — the previous read-check-write here was exactly the double-spend
      // race that migration was written to close).
      const { error: debitError } = await svc.rpc('debit_driver_wallet', {
        p_driver_id: user.id,
        p_amount: body.amount,
        p_to_card: true,
      });
      if (debitError) {
        const insufficient = debitError.message?.includes('INSUFFICIENT_FUNDS');
        return NextResponse.json(
          { error: insufficient ? 'Insufficient balance.' : 'Could not move funds. Try again.' },
          { status: insufficient ? 400 : 500 },
        );
      }
      const { data: walletAfter } = await svc
        .from('driver_wallets')
        .select('available')
        .eq('driver_id', user.id)
        .single();
      const newAvailable = Number(walletAfter?.available ?? 0);

      // Log payout
      await svc.from('driver_payouts').insert({
        driver_id: user.id,
        amount: body.amount,
        method: 'takeme_card',
        status: 'paid',
        completed_at: now,
      });

      // Log transaction
      await svc.from('driver_transactions').insert({
        driver_id: user.id,
        type: 'payout',
        amount: -body.amount,
        balance_after: newAvailable,
        description: 'Instant payout to TAKEME Card',
        status: 'completed',
      });

      await svc.from('driver_transactions').insert({
        driver_id: user.id,
        type: 'card_fund',
        amount: body.amount,
        balance_after: newAvailable,
        description: 'Funds added to TAKEME Card',
        status: 'completed',
      });

    } else {
      // Bank or debit: use Stripe Connect
      if (!wallet.stripe_account_id) {
        return NextResponse.json({
          error: 'No payout account connected. Add a bank account or debit card first.',
        }, { status: 400 });
      }

      try {
        const { createTransfer, createPayout } = await import('@/lib/stripe-payouts');

        // Transfer from platform → Connected account
        const transfer = await createTransfer({
          stripeAccountId: wallet.stripe_account_id,
          amount: Math.round(body.amount * 100),
          description: `TakeMe payout - ${user.id}`,
        });
        transferId = transfer.id;

        // Payout from Connected account → external account
        const payout = await createPayout({
          stripeAccountId: wallet.stripe_account_id,
          amount: Math.round(body.amount * 100),
          method: body.method === 'debit' ? 'instant' : 'standard',
          description: 'TakeMe driver payout',
        });
        payoutId = payout.id;

        // Deduct from wallet
        const newAvailable = Number(wallet.available) - body.amount;
        await svc.from('driver_wallets').update({
          available: newAvailable,
          updated_at: now,
        }).eq('driver_id', user.id);

        // Log
        await svc.from('driver_payouts').insert({
          driver_id: user.id,
          amount: body.amount,
          method: body.method,
          status: body.method === 'debit' ? 'in_transit' : 'pending',
          stripe_payout_id: payoutId,
          stripe_transfer_id: transferId,
        });

        await svc.from('driver_transactions').insert({
          driver_id: user.id,
          type: 'payout',
          amount: -body.amount,
          balance_after: newAvailable,
          description: `Payout to ${body.method === 'bank' ? 'bank account' : 'debit card'}`,
          status: 'completed',
        });

      } catch (stripeErr) {
        console.error('[payouts/instant] Stripe error:', stripeErr);
        return NextResponse.json({
          error: stripeErr instanceof Error ? stripeErr.message : 'Payout failed',
        }, { status: 500 });
      }
    }

    return NextResponse.json({
      success: true,
      amount: body.amount,
      method: body.method,
      payoutId,
    });
  } catch (err) {
    console.error('[payouts/instant]', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Payout failed' }, { status: 500 });
  }
}
