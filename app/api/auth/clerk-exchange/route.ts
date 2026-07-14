import { NextRequest, NextResponse } from 'next/server';

import { ensureShadowUser, identifyClerkUser, mintSupabaseToken } from '@/lib/auth/clerk';

/**
 * POST /api/auth/clerk-exchange
 *
 * Body: none. Auth: `Authorization: Bearer <Clerk session token>`.
 * Verifies the Clerk session, ensures the shadow Supabase user, and returns
 * the Supabase-compatible token the mobile app uses everywhere else.
 */
export async function POST(request: NextRequest) {
  try {
    const bearer = request.headers.get('authorization');
    const clerkToken = bearer?.replace(/^bearer\s+/i, '');
    if (!clerkToken) {
      return NextResponse.json({ error: 'Missing bearer token' }, { status: 401 });
    }

    const identity = await identifyClerkUser(clerkToken);
    if (!identity) {
      return NextResponse.json({ error: 'Invalid Clerk session' }, { status: 401 });
    }

    const userId = await ensureShadowUser(identity);
    const { token, expiresAt } = await mintSupabaseToken(userId, identity);

    return NextResponse.json({
      token,
      expiresAt,
      user: {
        id: userId,
        phone: identity.phone,
        email: identity.email,
        fullName: identity.fullName,
      },
    });
  } catch (error) {
    console.error('POST /api/auth/clerk-exchange failed:', error);
    return NextResponse.json({ error: 'Exchange failed' }, { status: 500 });
  }
}
