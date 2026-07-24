import { NextRequest, NextResponse } from 'next/server';
import { createApiClient } from '@/lib/supabase/api';
import { createServiceClient } from '@/lib/supabase/service';
import {
  addDays,
  bucketByLocalDay,
  isPayoutReturn,
  localDate,
  onlineSeconds,
  startOfLocalDay,
  summarizeEarnings,
  weekBounds,
  type LedgerRow,
} from '@/lib/driver-earnings-report';

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/driver/earnings?tz=<IANA>&anchor=<YYYY-MM-DD>
//
// The authoritative earnings dashboard payload: balances from driver_wallets
// + driver_payouts, a Monday-start week (containing `anchor`, default today
// in the driver's timezone) aggregated day-by-day from the immutable
// driver_transactions ledger, and online hours from driver_status_history
// (null — never zero — before tracking existed). All aggregation is
// timezone-correct; nothing is computed on the client.
// ═══════════════════════════════════════════════════════════════════════════

function safeTimeZone(tz: string | null): string {
  if (!tz) return 'America/Los_Angeles';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'America/Los_Angeles';
  }
}

export async function GET(request: NextRequest) {
  try {
    const { user } = await createApiClient(request);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const svc = createServiceClient();

    const { data: driver } = await svc
      .from('drivers')
      .select('id')
      .eq('auth_user_id', user.id)
      .maybeSingle();
    if (!driver) return NextResponse.json({ error: 'Not a driver' }, { status: 404 });

    const tz = safeTimeZone(request.nextUrl.searchParams.get('tz'));
    const today = localDate(new Date(), tz);
    const anchorParam = request.nextUrl.searchParams.get('anchor');
    const anchor = anchorParam && /^\d{4}-\d{2}-\d{2}$/.test(anchorParam) ? anchorParam : today;

    const week = weekBounds(anchor);
    const weekStartUtc = startOfLocalDay(week.start, tz);
    const weekEndUtc = startOfLocalDay(addDays(week.end, 1), tz);
    const todayStartUtc = startOfLocalDay(today, tz);
    const todayEndUtc = startOfLocalDay(addDays(today, 1), tz);

    const [{ data: wallet }, { data: weekRows }, { data: todayRows }, { data: openPayouts }] =
      await Promise.all([
        svc
          .from('driver_wallets')
          .select('available, pending, lifetime')
          .eq('driver_id', user.id)
          .maybeSingle(),
        svc
          .from('driver_transactions')
          .select('type, amount, ride_id, description, created_at')
          .eq('driver_id', user.id)
          .gte('created_at', weekStartUtc.toISOString())
          .lt('created_at', weekEndUtc.toISOString())
          .order('created_at', { ascending: true })
          .limit(2000),
        svc
          .from('driver_transactions')
          .select('type, amount, ride_id, description, created_at')
          .eq('driver_id', user.id)
          .gte('created_at', todayStartUtc.toISOString())
          .lt('created_at', todayEndUtc.toISOString())
          .limit(500),
        svc
          .from('driver_payouts')
          .select('amount, status')
          .eq('driver_id', user.id)
          .in('status', ['pending', 'in_transit']),
      ]);

    // Payout-failure returns reverse withdrawals; they are balance repairs,
    // not income — excluded from every earnings figure.
    const weekEarningRows = ((weekRows ?? []) as (LedgerRow & { description?: string | null })[]).filter(
      (r) => !isPayoutReturn(r),
    );
    const todayEarningRows = ((todayRows ?? []) as (LedgerRow & { description?: string | null })[]).filter(
      (r) => !isPayoutReturn(r),
    );

    // Online hours (week + today) from status history. One extra row before
    // the window supplies the opening state.
    const { data: historyRows } = await svc
      .from('driver_status_history')
      .select('status, effective_at')
      .eq('driver_id', driver.id)
      .gte('effective_at', new Date(weekStartUtc.getTime() - 24 * 3600 * 1000).toISOString())
      .order('effective_at', { ascending: true })
      .limit(2000);
    const { data: openingRow } = await svc
      .from('driver_status_history')
      .select('status, effective_at')
      .eq('driver_id', driver.id)
      .lt('effective_at', weekStartUtc.toISOString())
      .order('effective_at', { ascending: false })
      .limit(1);
    const history = [...(openingRow ?? []), ...(historyRows ?? [])].sort(
      (a, b) => new Date(a.effective_at).getTime() - new Date(b.effective_at).getTime(),
    );
    const weekOnlineSec = onlineSeconds(history, weekStartUtc, weekEndUtc);
    const todayOnlineSec = onlineSeconds(history, todayStartUtc, todayEndUtc);

    const inTransitUsd = (openPayouts ?? []).reduce((s, p) => s + Number(p.amount), 0);

    return NextResponse.json({
      timeZone: tz,
      balances: {
        availableUsd: Number(wallet?.available ?? 0),
        pendingUsd: Number(wallet?.pending ?? 0),
        lifetimeUsd: Number(wallet?.lifetime ?? 0),
        inTransitUsd,
      },
      today: {
        date: today,
        earnings: summarizeEarnings(todayEarningRows),
        onlineSeconds: todayOnlineSec,
      },
      week: {
        start: week.start,
        end: week.end,
        earnings: summarizeEarnings(weekEarningRows),
        onlineSeconds: weekOnlineSec,
        days: bucketByLocalDay(weekEarningRows, week.days, tz),
      },
      nav: {
        prevAnchor: addDays(week.start, -1),
        nextAnchor: week.end < today ? addDays(week.end, 1) : null,
      },
    });
  } catch (err) {
    console.error('GET /api/driver/earnings failed:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
