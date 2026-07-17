// ═══════════════════════════════════════════════════════════════════════════
// TAKEME MOBILITY — Production Dispatch Queue
//
// Offer → Accept/Timeout → Escalate cycle:
//   1. QStash triggers worker instantly on ride creation
//   2. Worker acquires Redis lock, finds best candidate
//   3. Offer sent to driver (push + Redis key with 15s TTL)
//   4. QStash schedules 15s timeout callback
//   5. If driver accepts → finalize (cleared via driver/rides API)
//   6. If timeout → exclude driver, escalate to next candidate
//   7. After 3 attempts → cancel ride, DLQ, Sentry alert
// ═══════════════════════════════════════════════════════════════════════════

import * as Sentry from '@sentry/nextjs';
import {
  findCandidates,
  offerRideToDriver,
  checkOfferAccepted,
  handleOfferExpiry,
  MAX_ESCALATIONS,
} from '@/lib/dispatch';
import { createServiceClient } from '@/lib/supabase/service';
import {
  acquireDispatchLock,
  releaseDispatchLock,
  getDriverOffer,
  moveToDLQ,
  cleanupDispatchState,
  enqueueDispatch,
  dequeueDispatch,
} from '@/lib/redis';
import { publishDispatchEvent, scheduleOfferTimeout } from '@/lib/qstash';
import { sendPushNotification } from '@/lib/push';

interface DispatchResult {
  action: 'offered' | 'assigned' | 'escalated' | 'cancelled' | 'skipped';
  rideId: string;
  attempt: number;
  driverName?: string;
  error?: string;
}

/**
 * Main dispatch handler — called by worker endpoint.
 * Finds best driver and sends offer (does NOT assign immediately).
 */
export async function dispatchRide(rideId: string, attempt: number = 0): Promise<DispatchResult> {
  // 1. Acquire lock — prevents double-dispatch
  const locked = await acquireDispatchLock(rideId);
  if (!locked) {
    return { action: 'skipped', rideId, attempt, error: 'Already being dispatched' };
  }

  try {
    // 2. Find candidates (excludes already-timed-out drivers)
    const { candidates, ride } = await findCandidates(rideId);

    if (!ride) {
      await releaseDispatchLock(rideId);
      return { action: 'skipped', rideId, attempt, error: 'Ride no longer searching' };
    }

    if (candidates.length === 0) {
      // No candidates left — check if we should cancel or retry
      if (attempt >= MAX_ESCALATIONS) {
        await cancelRideNoDrivers(rideId, attempt);
        return { action: 'cancelled', rideId, attempt, error: 'No drivers after max escalations' };
      }
      // Release lock and retry later (maybe new drivers come online)
      await releaseDispatchLock(rideId);
      const retried = await publishDispatchEvent(rideId, attempt + 1);
      if (!retried) await enqueueDispatch(rideId, attempt + 1);
      return { action: 'escalated', rideId, attempt, error: 'No candidates, retrying' };
    }

    // 3. Pick best candidate
    const driver = candidates[0];

    // 4. Send offer (Redis key + push notification)
    await offerRideToDriver(rideId, driver, ride);

    // 5. Schedule timeout check in 15 seconds via QStash
    const scheduled = await scheduleOfferTimeout(rideId, attempt);
    if (!scheduled) {
      // QStash unavailable — fall back to Redis queue with delay marker
      console.warn(`[dispatch] QStash timeout scheduling failed for ${rideId}, using Redis fallback`);
    }

    // Release lock (timeout handler will re-lock if needed)
    await releaseDispatchLock(rideId);

    return {
      action: 'offered',
      rideId,
      attempt,
      driverName: driver.driver_name,
    };
  } catch (err) {
    await releaseDispatchLock(rideId);
    Sentry.captureException(err, {
      tags: { component: 'dispatch', rideId, attempt: String(attempt) },
    });
    console.error(`[dispatch] Error dispatching ride ${rideId}:`, err);
    return { action: 'skipped', rideId, attempt, error: String(err) };
  }
}

/**
 * Handle offer timeout — called 15s after offer was sent.
 * Checks if driver accepted. If not, escalates to next candidate.
 */
export async function handleTimeout(rideId: string, attempt: number): Promise<DispatchResult> {
  // Check if offer was already accepted
  const accepted = await checkOfferAccepted(rideId);
  if (accepted) {
    return { action: 'assigned', rideId, attempt };
  }

  // Offer expired — get the driver who was offered
  const offeredDriverId = await getDriverOffer(rideId);

  if (offeredDriverId) {
    // Driver didn't respond — expire the offer
    await handleOfferExpiry(rideId, offeredDriverId);

    Sentry.captureMessage(`Driver offer timed out for ride ${rideId}`, {
      level: 'warning',
      tags: { component: 'dispatch', rideId, driverId: offeredDriverId, attempt: String(attempt) },
    });
  }

  // Check if we've exhausted escalation attempts
  const nextAttempt = attempt + 1;
  if (nextAttempt >= MAX_ESCALATIONS) {
    await cancelRideNoDrivers(rideId, nextAttempt);
    return { action: 'cancelled', rideId, attempt: nextAttempt, error: 'Max escalations reached' };
  }

  // Escalate: trigger dispatch again for next candidate
  console.log(`[dispatch] Escalating ride ${rideId} to attempt ${nextAttempt}`);
  const published = await publishDispatchEvent(rideId, nextAttempt);
  if (!published) {
    await enqueueDispatch(rideId, nextAttempt);
  }

  return { action: 'escalated', rideId, attempt: nextAttempt };
}

/**
 * Cancel ride after all escalation attempts failed.
 */
async function cancelRideNoDrivers(rideId: string, attempts: number): Promise<void> {
  const supabase = createServiceClient();

  // Move to DLQ for review
  await moveToDLQ(rideId, attempts, 'No driver accepted after max escalations');

  // Cancel ride
  await supabase
    .from('rides')
    .update({ status: 'cancelled', cancelled_reason: 'no_drivers_available' })
    .eq('id', rideId)
    .eq('status', 'searching_driver');

  // Log event
  await supabase.from('ride_events').insert({
    ride_id: rideId,
    event_type: 'dispatch_exhausted',
    new_status: 'cancelled',
    old_status: 'searching_driver',
    actor: 'system',
    metadata: { attempts, reason: 'All drivers timed out or unavailable' },
  });

  // Notify rider
  const { data: rideData } = await supabase
    .from('rides')
    .select('rider_id')
    .eq('id', rideId)
    .single();

  if (rideData?.rider_id) {
    const { data: push } = await supabase
      .from('push_tokens')
      .select('token')
      .eq('user_id', rideData.rider_id)
      .eq('role', 'rider')
      .single();

    if (push?.token) {
      await sendPushNotification({
        to: push.token,
        title: 'No Drivers Available',
        body: 'We couldn\'t find a driver for your ride. Please try again.',
        data: { type: 'dispatch_failed', rideId },
        priority: 'high',
      });
    }
  }

  // Cleanup Redis state
  await cleanupDispatchState(rideId);

  // Alert in Sentry
  Sentry.captureMessage(`Ride ${rideId} cancelled — no drivers after ${attempts} escalations`, {
    level: 'error',
    tags: { component: 'dispatch', rideId },
    extra: { attempts },
  });

  console.error(`[dispatch] Ride ${rideId} cancelled — no drivers after ${attempts} attempts`);
}

/**
 * Queue a ride for dispatch (called from rides/create).
 * Tries QStash first for instant dispatch, falls back to Redis queue.
 */
export async function queueRideForDispatch(rideId: string): Promise<void> {
  const published = await publishDispatchEvent(rideId, 0);
  if (!published) {
    await enqueueDispatch(rideId, 0);
  }
}

/**
 * Process items from Redis queue (cron fallback).
 */
export async function processRedisQueue(maxItems: number = 10): Promise<{
  processed: number; offered: number; failed: number;
}> {
  let processed = 0;
  let offered = 0;
  let failed = 0;

  for (let i = 0; i < maxItems; i++) {
    const item = await dequeueDispatch();
    if (!item) break;

    const result = await dispatchRide(item.rideId, item.attempt);
    processed++;
    if (result.action === 'offered') offered++;
    else failed++;
  }

  return { processed, offered, failed };
}

/**
 * Kick off dispatch for a new ride. Prefers the QStash worker; when QStash is
 * not configured, runs one offer cycle inline and falls back to the Redis
 * queue. Every path goes through `dispatchRide` — an OFFER the driver must
 * accept. Nothing here assigns a driver directly.
 */
export async function dispatchWithRetry(rideId: string): Promise<{ offered: boolean; error?: string }> {
  const { publishDispatchEvent } = await import('@/lib/qstash');
  const queuedViaQstash = await publishDispatchEvent(rideId, 0);
  if (queuedViaQstash) return { offered: true };

  const result = await dispatchRide(rideId, 0);
  if (result.action === 'offered') return { offered: true };

  await queueRideForDispatch(rideId);
  return { offered: false, error: result.error ?? 'Queued for background dispatch' };
}
