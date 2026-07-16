import { NextRequest, NextResponse } from 'next/server';

import {
  ensureShadowUser,
  loadClerkIdentity,
  syncRiderRecord,
  verifyClerkToken,
} from '@/lib/auth/clerk';

/**
 * POST /api/auth/profile
 *
 * Auth: `Authorization: Bearer <Clerk session token>`. Called by the mobile
 * apps right after a Clerk sign-in (and on cold start): verifies the session,
 * ensures the shadow Supabase user exists, and returns the platform identity
 * — most importantly the Supabase user id that `rides.rider_id` and every
 * other table key on. No tokens are minted here; the apps keep using their
 * Clerk session token everywhere.
 */
export async function POST(request: NextRequest) {
  try {
    const bearer = request.headers.get('authorization');
    const clerkToken = bearer?.replace(/^bearer\s+/i, '');
    if (!clerkToken) {
      return NextResponse.json({ error: 'Missing bearer token' }, { status: 401 });
    }

    const sub = await verifyClerkToken(clerkToken);
    if (!sub) {
      return NextResponse.json({ error: 'Invalid Clerk session' }, { status: 401 });
    }

    const identity = await loadClerkIdentity(sub);
    const userId = await ensureShadowUser(identity);
    // Keep the platform's rider record in step with Clerk (name, contact,
    // photo) so admin and driver surfaces show current identity.
    await syncRiderRecord(userId, identity);

    return NextResponse.json({
      user: {
        id: userId,
        phone: identity.phone,
        email: identity.email,
        fullName: identity.fullName,
        avatarUrl: identity.avatarUrl,
      },
    });
  } catch (error) {
    console.error('POST /api/auth/profile failed:', error);
    return NextResponse.json({ error: 'Profile lookup failed' }, { status: 500 });
  }
}
