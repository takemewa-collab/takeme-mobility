// ═══════════════════════════════════════════════════════════════════════════
// TAKEME MOBILITY — Upstash Redis Client
// Serverless Redis for dispatch queue, driver cache, rate limiting.
// ═══════════════════════════════════════════════════════════════════════════

import { Redis } from '@upstash/redis';

let redis: Redis | null = null;

export function getRedis(): Redis {
  if (!redis) {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) {
      throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN required');
    }
    redis = new Redis({ url, token });
  }
  return redis;
}

// ── Driver availability cache ────────────────────────────────────────────
// Stores online drivers with their location for fast proximity lookups.
// TTL: 90 seconds (drivers must send heartbeat via location updates)

interface CachedDriverLocation {
  driverId: string;
  lat: number;
  lng: number;
  heading: number | null;
  speedKmh: number | null;
  vehicleClass: string;
  updatedAt: number; // epoch ms
}

const DRIVER_KEY_PREFIX = 'driver:loc:';
const ONLINE_DRIVERS_SET = 'drivers:online';
const DRIVER_TTL = 90; // seconds

export async function cacheDriverLocation(data: CachedDriverLocation): Promise<void> {
  const r = getRedis();
  const key = `${DRIVER_KEY_PREFIX}${data.driverId}`;

  await Promise.all([
    r.set(key, JSON.stringify(data), { ex: DRIVER_TTL }),
    r.sadd(ONLINE_DRIVERS_SET, data.driverId),
    r.expire(ONLINE_DRIVERS_SET, 300), // cleanup set every 5 min
  ]);
}

export async function getDriverLocation(driverId: string): Promise<CachedDriverLocation | null> {
  const r = getRedis();
  const data = await r.get<string>(`${DRIVER_KEY_PREFIX}${driverId}`);
  if (!data) return null;
  return typeof data === 'string' ? JSON.parse(data) : data as unknown as CachedDriverLocation;
}

export async function getOnlineDriverIds(): Promise<string[]> {
  const r = getRedis();
  return (await r.smembers(ONLINE_DRIVERS_SET)) as string[];
}

export async function removeDriverFromCache(driverId: string): Promise<void> {
  const r = getRedis();
  await Promise.all([
    r.del(`${DRIVER_KEY_PREFIX}${driverId}`),
    r.srem(ONLINE_DRIVERS_SET, driverId),
  ]);
}

// ── Generic rate limiter ─────────────────────────────────────────────────
export async function checkRateLimit(
  key: string,
  maxRequests: number,
  windowSeconds: number,
): Promise<{ allowed: boolean; remaining: number }> {
  const r = getRedis();
  const fullKey = `ratelimit:${key}`;
  const current = await r.incr(fullKey);

  if (current === 1) {
    await r.expire(fullKey, windowSeconds);
  }

  return {
    allowed: current <= maxRequests,
    remaining: Math.max(0, maxRequests - current),
  };
}

// ── Dispatch queue (Redis-backed) ────────────────────────────────────────
const DISPATCH_QUEUE = 'queue:dispatch';

export async function enqueueDispatch(rideId: string, attempt: number = 0): Promise<void> {
  const r = getRedis();
  const item = JSON.stringify({ rideId, attempt, enqueuedAt: Date.now() });
  await r.lpush(DISPATCH_QUEUE, item);
}

export async function dequeueDispatch(): Promise<{ rideId: string; attempt: number } | null> {
  const r = getRedis();
  const item = await r.rpop<string>(DISPATCH_QUEUE);
  if (!item) return null;
  return typeof item === 'string' ? JSON.parse(item) : item as unknown as { rideId: string; attempt: number };
}

export async function getDispatchQueueLength(): Promise<number> {
  const r = getRedis();
  return r.llen(DISPATCH_QUEUE);
}

// ── Dispatch lock (prevents double-dispatch) ─────────────────────────────

export async function acquireDispatchLock(rideId: string, ttlSec: number = 60): Promise<boolean> {
  const r = getRedis();
  const key = `dispatch:lock:${rideId}`;
  const result = await r.set(key, '1', { nx: true, ex: ttlSec });
  return result === 'OK';
}

export async function releaseDispatchLock(rideId: string): Promise<void> {
  const r = getRedis();
  await r.del(`dispatch:lock:${rideId}`);
}

// ── Driver offer tracking (15s TTL per offer) ────────────────────────────

export async function setDriverOffer(rideId: string, driverId: string, ttlSec: number = 15): Promise<void> {
  const r = getRedis();
  await r.set(`dispatch:offer:${rideId}`, driverId, { ex: ttlSec });
}

export async function getDriverOffer(rideId: string): Promise<string | null> {
  const r = getRedis();
  return r.get<string>(`dispatch:offer:${rideId}`);
}

export async function clearDriverOffer(rideId: string): Promise<void> {
  const r = getRedis();
  await r.del(`dispatch:offer:${rideId}`);
}

/**
 * Driver explicitly declined the offer. The key must NOT be deleted — a
 * missing key reads as "accepted" to the timeout checker — so the value is
 * replaced with a sentinel the accept path can never match. `xx` keeps this a
 * no-op when the offer already expired; `keepTtl` preserves the original
 * expiry so the scheduled timeout escalates on its normal cadence.
 */
export async function markOfferDeclined(rideId: string): Promise<boolean> {
  const r = getRedis();
  const result = await r.set(`dispatch:offer:${rideId}`, 'declined', { xx: true, keepTtl: true });
  return result === 'OK';
}

// ── Excluded drivers (already offered + timed out for this ride) ─────────

export async function addExcludedDriver(rideId: string, driverId: string): Promise<void> {
  const r = getRedis();
  const key = `dispatch:excluded:${rideId}`;
  await r.sadd(key, driverId);
  await r.expire(key, 300); // 5 min TTL
}

export async function getExcludedDrivers(rideId: string): Promise<string[]> {
  const r = getRedis();
  return (await r.smembers(`dispatch:excluded:${rideId}`)) as string[];
}

// ── Cleanup all dispatch state for a ride ────────────────────────────────

export async function cleanupDispatchState(rideId: string): Promise<void> {
  const r = getRedis();
  await Promise.all([
    r.del(`dispatch:lock:${rideId}`),
    r.del(`dispatch:offer:${rideId}`),
    r.del(`dispatch:excluded:${rideId}`),
  ]);
}

// ── Dead-letter queue (failed dispatches) ────────────────────────────────
const DLQ = 'queue:dispatch:dlq';

interface DLQItem {
  rideId: string;
  attempts: number;
  lastError: string;
  failedAt: number;
}

export async function moveToDLQ(rideId: string, attempts: number, error: string): Promise<void> {
  const r = getRedis();
  const item: DLQItem = { rideId, attempts, lastError: error, failedAt: Date.now() };
  await r.lpush(DLQ, JSON.stringify(item));
}

export async function getDLQItems(limit: number = 50): Promise<DLQItem[]> {
  const r = getRedis();
  const items = await r.lrange(DLQ, 0, limit - 1);
  return items.map(item =>
    typeof item === 'string' ? JSON.parse(item) : item as unknown as DLQItem
  );
}

export async function getDLQLength(): Promise<number> {
  const r = getRedis();
  return r.llen(DLQ);
}

export async function retryFromDLQ(): Promise<DLQItem | null> {
  const r = getRedis();
  const item = await r.rpop<string>(DLQ);
  if (!item) return null;
  const parsed = typeof item === 'string' ? JSON.parse(item) : item as unknown as DLQItem;
  // Re-enqueue to main dispatch queue with reset attempt counter
  await enqueueDispatch(parsed.rideId, 0);
  return parsed;
}

export async function clearDLQ(): Promise<number> {
  const r = getRedis();
  const len = await r.llen(DLQ);
  if (len > 0) await r.del(DLQ);
  return len;
}
