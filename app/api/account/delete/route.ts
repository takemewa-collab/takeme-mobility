import { NextRequest, NextResponse } from 'next/server';
import { getRequestUser } from '@/lib/auth/request-user';
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

export async function POST(request: NextRequest) {
  try {
    const user = await getRequestUser(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const userId = user.id;

    const svc = createServiceClient();
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
