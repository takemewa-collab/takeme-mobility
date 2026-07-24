import { NextRequest, NextResponse } from 'next/server';
import { dispatchRide, handleTimeout, processRedisQueue, sweepStuckSearchingRides } from '@/lib/dispatch-queue';
import { getDispatchQueueLength } from '@/lib/redis';
import { verifyInternalRequest } from '@/lib/auth/internal-auth';

// ═══════════════════════════════════════════════════════════════════════════
// /api/dispatch/worker
//
// Action-based routing:
//   POST { action: 'dispatch',      rideId, attempt } — Find + offer driver
//   POST { action: 'timeout_check', rideId, attempt } — Check if accepted, escalate
//   GET  (with CRON_SECRET)                           — Process Redis queue (cron)
//   GET  (no auth)                                    — Health check
// ═══════════════════════════════════════════════════════════════════════════

function isAuthorized(request: NextRequest): boolean {
  // Fail closed: require the internal Bearer secret. Previously this returned
  // true when CRON_SECRET was unset and trusted the mere presence of an
  // (unverified) upstash-signature header — both let anyone drive dispatch.
  return verifyInternalRequest(request);
}

// GET — Vercel Cron (safety net, every 1 min) or health check
export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    try {
      const queueLength = await getDispatchQueueLength();
      return NextResponse.json({ queueLength, status: 'ready' });
    } catch {
      return NextResponse.json({ error: 'Redis unavailable' }, { status: 500 });
    }
  }

  try {
    const result = await processRedisQueue(10);
    // Durability net: re-drive searching rides whose dispatch chain died
    // (e.g. a dropped QStash delivery) so they either match or terminate.
    const sweep = await sweepStuckSearchingRides();
    return NextResponse.json({ ...result, sweep });
  } catch (err) {
    console.error('[dispatch-worker] Cron error:', err);
    return NextResponse.json({ error: 'Worker failed' }, { status: 500 });
  }
}

// POST — QStash event-driven dispatch (instant)
export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json().catch(() => ({})) as {
      rideId?: string;
      attempt?: number;
      action?: 'dispatch' | 'timeout_check';
    };

    if (!body.rideId) {
      // No rideId — process Redis queue
      const result = await processRedisQueue(10);
      return NextResponse.json(result);
    }

    const { rideId, attempt = 0, action = 'dispatch' } = body;

    if (action === 'timeout_check') {
      // 15s timeout fired — check if driver accepted, escalate if not
      const result = await handleTimeout(rideId, attempt);
      console.log(`[dispatch-worker] Timeout: ride ${rideId} → ${result.action}`);
      return NextResponse.json(result);
    }

    // Default: find driver and send offer
    const result = await dispatchRide(rideId, attempt);
    console.log(`[dispatch-worker] Dispatch: ride ${rideId} → ${result.action}`);
    return NextResponse.json(result);
  } catch (err) {
    console.error('[dispatch-worker] Error:', err);
    return NextResponse.json({ error: 'Worker failed' }, { status: 500 });
  }
}
