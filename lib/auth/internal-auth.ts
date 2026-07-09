import crypto from 'node:crypto';

// ═══════════════════════════════════════════════════════════════════════════
// Internal / cron authorization — FAIL CLOSED.
//
// Server-to-server and Vercel Cron calls must present
//   Authorization: Bearer $CRON_SECRET
// Vercel automatically attaches this header to cron invocations when the
// CRON_SECRET env var is set, so the same check covers both internal fetches
// (see lib/qstash.ts) and scheduled crons.
//
// Deliberately does NOT trust the `x-vercel-cron` header — that header is
// client-settable and NOT stripped at the edge, so trusting it alone is a
// full authorization bypass (verified: an external request with
// `x-vercel-cron: 1` reached protected cron routes). Authorization rests
// solely on the Bearer secret. If CRON_SECRET is unset we return false
// (fail closed) rather than allowing the call. The comparison is constant
// time to avoid leaking the secret through response timing.
// ═══════════════════════════════════════════════════════════════════════════

export function verifyInternalRequest(request: Request): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return false; // fail closed — no secret, no access

  const provided = request.headers.get('authorization');
  if (!provided) return false;

  const a = Buffer.from(provided);
  const b = Buffer.from(`Bearer ${cronSecret}`);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
