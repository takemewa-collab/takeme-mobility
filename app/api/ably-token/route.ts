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

    // ACTIVE rides only, where the caller is the rider or the assigned
    // driver. Completed/cancelled rides grant nothing — combined with the
    // short token TTL, a rider's access to the driver's position lapses as
    // soon as the ride ends. There are no driver-wide channels at all.
    const svc = createServiceClient();
    const { data: driverRow } = await svc
      .from('drivers')
      .select('id')
      .eq('auth_user_id', user.id)
      .maybeSingle();

    const party = driverRow
      ? `rider_id.eq.${user.id},assigned_driver_id.eq.${driverRow.id}`
      : `rider_id.eq.${user.id}`;

    const { data: rides } = await svc
      .from('rides')
      .select('id')
      .or(party)
      .in('status', ['driver_assigned', 'driver_arriving', 'arrived', 'in_progress'])
      .order('requested_at', { ascending: false })
      .limit(5);

    const capability: Record<string, string[]> = {};
    for (const r of rides ?? []) {
      capability[`ride:${r.id}`] = ['subscribe'];
    }
    if (Object.keys(capability).length === 0) {
      // No active ride — no channels. Issue nothing rather than a hollow token.
      return NextResponse.json({ token: null });
    }

    const token = await createAblyToken(user.id, capability);
    return NextResponse.json({ token });
  } catch (err) {
    console.error('[ably-token]', err);
    return NextResponse.json({ error: 'Failed to create token' }, { status: 500 });
  }
}
