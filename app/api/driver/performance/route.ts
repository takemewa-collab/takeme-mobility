import { NextRequest, NextResponse } from 'next/server';
import { createApiClient } from '@/lib/supabase/api';
import { createServiceClient } from '@/lib/supabase/service';

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/driver/performance — rating, acceptance/completion/cancellation
// rates over the last 30 days, derived ONLY from real dispatch events and
// ride outcomes. Rates with too few data points return null and the sample
// sizes are always included — the UI shows "not enough data yet" instead of
// a fabricated 100%.
// ═══════════════════════════════════════════════════════════════════════════

const WINDOW_DAYS = 30;
const MIN_OFFERS_FOR_RATE = 5;
const MIN_TRIPS_FOR_RATE = 5;

export async function GET(request: NextRequest) {
  try {
    const { user } = await createApiClient(request);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const svc = createServiceClient();

    const { data: driver } = await svc
      .from('drivers')
      .select('id, rating, total_trips, created_at')
      .eq('auth_user_id', user.id)
      .maybeSingle();
    if (!driver) return NextResponse.json({ error: 'Not a driver' }, { status: 404 });

    const since = new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000).toISOString();

    // Offer funnel: events carry this driver's id in metadata.
    const countEvents = async (eventType: string) => {
      const { count } = await svc
        .from('ride_events')
        .select('id', { count: 'exact', head: true })
        .eq('event_type', eventType)
        .eq('metadata->>driver_id', driver.id)
        .gte('created_at', since);
      return count ?? 0;
    };
    const [offersSent, offersDeclined, offersTimedOut, accepted] = await Promise.all([
      countEvents('offer_sent'),
      countEvents('offer_declined'),
      countEvents('offer_timeout'),
      countEvents('driver_assigned'),
    ]);

    // Trip outcomes for rides assigned to this driver in the window.
    const { data: outcomes } = await svc
      .from('rides')
      .select('status, cancelled_by')
      .eq('assigned_driver_id', driver.id)
      .in('status', ['completed', 'cancelled'])
      .gte('requested_at', since)
      .limit(2000);
    const completed = (outcomes ?? []).filter((r) => r.status === 'completed').length;
    const driverCancelled = (outcomes ?? []).filter(
      (r) => r.status === 'cancelled' && r.cancelled_by === 'driver',
    ).length;
    const decidedTrips = completed + driverCancelled;

    const rate = (num: number, den: number, minDen: number) =>
      den >= minDen ? Math.round((num / den) * 1000) / 10 : null;

    return NextResponse.json({
      windowDays: WINDOW_DAYS,
      rating: driver.rating != null ? Number(driver.rating) : null,
      totalTrips: Number(driver.total_trips ?? 0),
      driverSince: driver.created_at,
      offers: {
        sent: offersSent,
        accepted,
        declined: offersDeclined,
        timedOut: offersTimedOut,
        acceptanceRatePct: rate(accepted, offersSent, MIN_OFFERS_FOR_RATE),
      },
      trips: {
        completed,
        cancelledByYou: driverCancelled,
        completionRatePct: rate(completed, decidedTrips, MIN_TRIPS_FOR_RATE),
        cancellationRatePct: rate(driverCancelled, decidedTrips, MIN_TRIPS_FOR_RATE),
      },
    });
  } catch (err) {
    console.error('GET /api/driver/performance failed:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
