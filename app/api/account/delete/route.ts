import { createClerkClient } from '@clerk/backend';
import { NextRequest, NextResponse } from 'next/server';
import { verifyMintedBearer } from '@/lib/auth/verify-bearer';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/account/delete
//
// In-app account deletion. Required by Apple (Guideline 5.1.1(v)) and Google
// Play for any app that lets users create an account.
//
// Authenticates the CALLER (cookie session for web, Bearer JWT for mobile),
// then hard-deletes their auth.users row. Every domain table keys off
// auth.users(id) with ON DELETE CASCADE (riders → rides → payments → …), so
// this removes the user's personal data across the schema in one operation.
// ═══════════════════════════════════════════════════════════════════════════

async function resolveUserId(request: NextRequest): Promise<string | null> {
  // Mobile: Authorization: Bearer <access_token>
  const authHeader = request.headers.get('authorization');
  const token = authHeader?.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : null;

  if (token) {
    // Platform-minted (Clerk exchange) tokens verify locally.
    const minted = await verifyMintedBearer(token);
    if (minted) return minted.id;

    const svc = createServiceClient();
    const { data, error } = await svc.auth.getUser(token);
    if (error || !data.user) return null;
    return data.user.id;
  }

  // Web: cookie-based session
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}

export async function POST(request: NextRequest) {
  try {
    const userId = await resolveUserId(request);
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const svc = createServiceClient();

    // If this account came through Clerk, delete the Clerk user too so the
    // person is fully erased on both identity systems (5.1.1(v)).
    const { data: link } = await svc
      .from('clerk_links')
      .select('clerk_id')
      .eq('user_id', userId)
      .maybeSingle();
    if (link?.clerk_id && process.env.CLERK_SECRET_KEY) {
      const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
      await clerk.users.deleteUser(link.clerk_id).catch((err) => {
        console.error('[account/delete] clerk deleteUser failed (continuing):', err);
      });
    }

    const { error } = await svc.auth.admin.deleteUser(userId);
    if (error) {
      console.error('[account/delete] deleteUser failed:', error.message);
      return NextResponse.json({ error: 'Account deletion failed' }, { status: 500 });
    }

    return NextResponse.json({ deleted: true });
  } catch (err) {
    console.error('[account/delete]', err);
    return NextResponse.json({ error: 'Account deletion failed' }, { status: 500 });
  }
}
