import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createApiClient } from '@/lib/supabase/api';
import { createServiceClient } from '@/lib/supabase/service';

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/driver/notifications?before=<ISO>&limit=N — the driver's
//     notification center: real backend events only (payouts, documents,
//     compliance, rides, safety). Includes the unread count.
// PUT /api/driver/notifications — mark read: { ids: [...] } or { all: true }.
// ═══════════════════════════════════════════════════════════════════════════

export async function GET(request: NextRequest) {
  try {
    const { user } = await createApiClient(request);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const svc = createServiceClient();

    const params = request.nextUrl.searchParams;
    const limit = Math.min(50, Math.max(1, Number(params.get('limit') ?? 30)));
    const before = params.get('before');

    let query = svc
      .from('driver_notifications')
      .select('id, category, title, body, data, created_at, read_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (before) query = query.lt('created_at', before);
    const { data: notifications, error } = await query;
    if (error) throw error;

    const { count: unread } = await svc
      .from('driver_notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .is('read_at', null);

    return NextResponse.json({
      notifications: notifications ?? [],
      unreadCount: unread ?? 0,
      nextBefore:
        notifications && notifications.length === limit
          ? notifications[notifications.length - 1].created_at
          : null,
    });
  } catch (err) {
    console.error('GET /api/driver/notifications failed:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}

const markSchema = z.union([
  z.object({ ids: z.array(z.string().uuid()).min(1).max(100) }),
  z.object({ all: z.literal(true) }),
]);

export async function PUT(request: NextRequest) {
  try {
    const { user } = await createApiClient(request);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const svc = createServiceClient();

    const body = markSchema.parse(await request.json());
    const now = new Date().toISOString();

    let query = svc
      .from('driver_notifications')
      .update({ read_at: now })
      .eq('user_id', user.id)
      .is('read_at', null);
    if ('ids' in body) query = query.in('id', body.ids);
    const { error } = await query;
    if (error) throw error;

    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }
    console.error('PUT /api/driver/notifications failed:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
