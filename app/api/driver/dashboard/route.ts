import { NextRequest, NextResponse } from 'next/server';
import { getRequestUser } from '@/lib/auth/request-user';
import { createServiceClient } from '@/lib/supabase/service';

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/driver/dashboard
// Returns all dashboard data for the current driver in a single call.
// ═══════════════════════════════════════════════════════════════════════════

export async function GET(request: NextRequest) {
  try {
    const user = await getRequestUser(request);
    if (!user) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });

    const svc = createServiceClient();

    // Wallet
    const { data: wallet } = await svc
      .from('driver_wallets')
      .select('available, pending, lifetime, card_balance, payout_method')
      .eq('driver_id', user.id)
      .maybeSingle();

    // Recent transactions
    const { data: transactions } = await svc
      .from('driver_transactions')
      .select('id, type, amount, description, status, created_at')
      .eq('driver_id', user.id)
      .order('created_at', { ascending: false })
      .limit(10);

    // Recent payouts
    const { data: payouts } = await svc
      .from('driver_payouts')
      .select('id, amount, method, status, initiated_at, completed_at')
      .eq('driver_id', user.id)
      .order('created_at', { ascending: false })
      .limit(5);

    // Card status
    const { data: card } = await svc
      .from('driver_cards')
      .select('card_status, shipping_status, stripe_virtual_card_id, stripe_physical_card_id')
      .eq('driver_id', user.id)
      .maybeSingle();

    return NextResponse.json({
      wallet: wallet ?? { available: 0, pending: 0, lifetime: 0, card_balance: 0, payout_method: 'takeme_card' },
      transactions: transactions ?? [],
      payouts: payouts ?? [],
      card: card ?? null,
    });
  } catch (err) {
    console.error('[driver/dashboard]', err);
    return NextResponse.json({ error: 'Failed to load dashboard' }, { status: 500 });
  }
}
