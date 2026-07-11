import { NextRequest, NextResponse } from 'next/server';
import { createApiClient } from '@/lib/supabase/api';
import { createServiceClient } from '@/lib/supabase/service';
import { createAblyToken } from '@/lib/ably';

// GET /api/ably-token — Issue a scoped Ably token for the authenticated user.
// The token only grants subscribe on the caller's own rides and their assigned
// drivers — not the wildcard `ride:*`/`driver:*` it used to hand out.
export async function GET(request: NextRequest) {
  try {
    const { user } = await createApiClient(request);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    // Rides where the caller is the rider or the assigned driver.
    const svc = createServiceClient();
    const { data: rides } = await svc
      .from('rides')
      .select('id, assigned_driver_id')
      .or(`rider_id.eq.${user.id},assigned_driver_id.eq.${user.id}`)
      .order('requested_at', { ascending: false })
      .limit(20);

    const capability: Record<string, string[]> = {};
    for (const r of rides ?? []) {
      capability[`ride:${r.id}`] = ['subscribe'];
      if (r.assigned_driver_id) capability[`driver:${r.assigned_driver_id}`] = ['subscribe'];
    }
    // A driver may go online before having a ride — let them see their own channel.
    capability[`driver:${user.id}`] = ['subscribe'];

    const token = await createAblyToken(user.id, capability);
    return NextResponse.json({ token });
  } catch (err) {
    console.error('[ably-token]', err);
    return NextResponse.json({ error: 'Failed to create token' }, { status: 500 });
  }
}
