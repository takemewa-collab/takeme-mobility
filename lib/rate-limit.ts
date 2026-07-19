// ═══════════════════════════════════════════════════════════════════════════
// TAKEME MOBILITY — API Rate Limiting & Abuse Prevention
// Redis-backed rate limiter for all API endpoints.
//
// Limits:
//   - OTP send: 3 per phone per 5 min (already in DB, this adds IP-level)
//   - OTP verify: 5 per phone per 5 min
//   - Ride create: 5 per user per 10 min
//   - Driver location: 60 per driver per min (1/sec)
//   - Quotes: 30 per IP per min
//   - General API: 100 per IP per min
// ═══════════════════════════════════════════════════════════════════════════

import { checkRateLimit } from '@/lib/redis';
import { NextRequest, NextResponse } from 'next/server';

interface RateLimitConfig {
  maxRequests: number;
  windowSeconds: number;
}

const RATE_LIMITS: Record<string, RateLimitConfig> = {
  'send-otp': { maxRequests: 3, windowSeconds: 300 },
  'verify-otp': { maxRequests: 5, windowSeconds: 300 },
  'rides-create': { maxRequests: 5, windowSeconds: 600 },
  'driver-location': { maxRequests: 60, windowSeconds: 60 },
  'quotes': { maxRequests: 30, windowSeconds: 60 },
  'airports': { maxRequests: 60, windowSeconds: 60 },
  'default': { maxRequests: 100, windowSeconds: 60 },
};

function getClientIP(request: NextRequest): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? request.headers.get('x-real-ip')
    ?? 'unknown';
}

/**
 * Check rate limit for an API endpoint.
 * Returns null if allowed, or a 429 response if rate limited.
 */
// Auth/OTP endpoints protect against brute force / account takeover, so if the
// rate-limiter backend (Redis) is unavailable they must FAIL CLOSED — otherwise
// an attacker who can knock Redis offline gets unlimited OTP guesses. Other
// endpoints fail open so a Redis blip doesn't take down the whole app.
const FAIL_CLOSED_ENDPOINTS = new Set(['send-otp', 'verify-otp']);

export async function rateLimit(
  request: NextRequest,
  endpoint: string,
  identifier?: string,
): Promise<NextResponse | null> {
  const config = RATE_LIMITS[endpoint] ?? RATE_LIMITS['default'];
  const ip = getClientIP(request);
  const key = identifier ? `${endpoint}:${identifier}` : `${endpoint}:${ip}`;

  try {
    const result = await checkRateLimit(key, config.maxRequests, config.windowSeconds);

    if (!result.allowed) {
      return NextResponse.json(
        { error: 'Too many requests. Please try again later.' },
        {
          status: 429,
          headers: {
            'Retry-After': String(config.windowSeconds),
            'X-RateLimit-Limit': String(config.maxRequests),
            'X-RateLimit-Remaining': '0',
          },
        },
      );
    }

    return null; // allowed
  } catch (err) {
    if (FAIL_CLOSED_ENDPOINTS.has(endpoint)) {
      console.error(`[rate-limit] backend unavailable for ${endpoint} — failing closed:`, err);
      return NextResponse.json(
        { error: 'Service temporarily unavailable. Please try again shortly.' },
        { status: 503 },
      );
    }
    // Non-sensitive endpoint — allow the request (fail open).
    return null;
  }
}

/**
 * Detect suspicious patterns for abuse prevention.
 */
export function detectAbuse(request: NextRequest): { suspicious: boolean; reason?: string } {
  const ua = request.headers.get('user-agent') ?? '';
  const ip = getClientIP(request);

  // No user agent
  if (!ua || ua.length < 5) {
    return { suspicious: true, reason: 'Missing user-agent' };
  }

  // Known bot patterns
  const botPatterns = /curl|wget|python-requests|scrapy|postman/i;
  if (botPatterns.test(ua) && !process.env.ALLOW_BOTS) {
    return { suspicious: true, reason: `Bot user-agent: ${ua.substring(0, 50)}` };
  }

  return { suspicious: false };
}
