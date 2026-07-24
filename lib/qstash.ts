// ═══════════════════════════════════════════════════════════════════════════
// TAKEME MOBILITY — QStash Event-Driven Dispatch
// Instant dispatch on ride creation + 15s timeout scheduling.
// ═══════════════════════════════════════════════════════════════════════════

import { Client } from '@upstash/qstash';

let qstashClient: Client | null = null;

function getQStash(): Client | null {
  if (!qstashClient) {
    // Support multi-region: US East 1 (primary) → EU Central 1 (fallback) → legacy QSTASH_TOKEN
    const token = process.env.US_EAST_1_QSTASH_TOKEN
      ?? process.env.QSTASH_TOKEN
      ?? process.env.EU_CENTRAL_1_QSTASH_TOKEN;
    if (!token) return null;

    const baseUrl = process.env.US_EAST_1_QSTASH_URL
      ?? process.env.EU_CENTRAL_1_QSTASH_URL;

    qstashClient = new Client({
      token,
      ...(baseUrl ? { baseUrl } : {}),
    });
  }
  return qstashClient;
}

/**
 * Where QStash must deliver dispatch events. Pure and exported for tests.
 *
 * MUST prefer the canonical public site URL: per-deployment hosts
 * (VERCEL_URL, e.g. takeme-mobility-xxxx.vercel.app) sit behind Vercel
 * deployment protection, so QStash POSTs die at the auth wall and never
 * reach the worker — rides then strand in searching_driver forever because
 * publishJSON still reported success and the inline fallback was skipped.
 */
export function resolveWorkerUrl(env: Record<string, string | undefined>): string | null {
  const host =
    env.NEXT_PUBLIC_SITE_URL
    ?? env.VERCEL_PROJECT_PRODUCTION_URL
    ?? env.NEXT_PUBLIC_VERCEL_URL
    ?? env.VERCEL_URL;
  if (!host) return null;
  let base = (host.startsWith('http') ? host : `https://${host}`).replace(/\/+$/, '');
  // The apex 308-redirects every request to www, and a redirected POST loses
  // QStash deliveries — normalize to the canonical www host.
  base = base.replace('://takememobility.com', '://www.takememobility.com');
  return `${base}/api/dispatch/worker`;
}

function getWorkerUrl(): string | null {
  return resolveWorkerUrl(process.env as Record<string, string | undefined>);
}

/**
 * Publish dispatch event — triggers worker immediately.
 * Called when a new ride is created.
 */
export async function publishDispatchEvent(rideId: string, attempt: number = 0): Promise<boolean> {
  const client = getQStash();
  const url = getWorkerUrl();
  if (!client || !url) return false;

  try {
    await client.publishJSON({
      url,
      body: { rideId, attempt, action: 'dispatch' },
      retries: 2,
      headers: { 'Authorization': `Bearer ${process.env.CRON_SECRET ?? ''}` },
    });
    console.log(`[qstash] Dispatch event → ride ${rideId} (attempt ${attempt})`);
    return true;
  } catch (err) {
    console.error('[qstash] Publish failed:', err);
    return false;
  }
}

/**
 * Schedule a timeout check — fires 15 seconds after offer is sent.
 * If driver hasn't accepted by then, the worker will escalate.
 */
export async function scheduleOfferTimeout(rideId: string, attempt: number): Promise<boolean> {
  const client = getQStash();
  const url = getWorkerUrl();
  if (!client || !url) return false;

  try {
    await client.publishJSON({
      url,
      body: { rideId, attempt, action: 'timeout_check' },
      delay: 15, // 15 seconds
      retries: 1,
      headers: { 'Authorization': `Bearer ${process.env.CRON_SECRET ?? ''}` },
    });
    console.log(`[qstash] Timeout scheduled → ride ${rideId} in 15s`);
    return true;
  } catch (err) {
    console.error('[qstash] Timeout schedule failed:', err);
    return false;
  }
}

/**
 * Schedule a delayed retry for dispatch.
 */
export async function scheduleDispatchRetry(rideId: string, attempt: number): Promise<boolean> {
  return publishDispatchEvent(rideId, attempt);
}
