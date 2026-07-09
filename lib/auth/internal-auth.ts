import type { NextRequest } from 'next/server';

// ═══════════════════════════════════════════════════════════════════════════
// Internal / cron authorization — FAIL CLOSED.
//
// Server-to-server and Vercel Cron calls must present
//   Authorization: Bearer $CRON_SECRET
// Vercel automatically attaches this header to cron invocations when the
// CRON_SECRET env var is set, so the same check covers both internal fetches
// (see lib/qstash.ts) and scheduled crons.
//
// Deliberately does NOT trust the `x-vercel-cron` header on its own — that
// header is client-settable and therefore spoofable. If CRON_SECRET is not
// configured we return false (fail closed) rather than allowing the call.
// ═══════════════════════════════════════════════════════════════════════════

export function verifyInternalRequest(request: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return false; // fail closed — no secret, no access
  return request.headers.get('authorization') === `Bearer ${cronSecret}`;
}
