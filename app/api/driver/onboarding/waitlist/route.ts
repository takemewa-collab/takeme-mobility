import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createApiClient } from '@/lib/supabase/api';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimit } from '@/lib/rate-limit';
import { latestApplication, logEvent } from '@/lib/onboarding/service';

// ═══════════════════════════════════════════════════════════════════════════
// GET    /api/driver/onboarding/waitlist — the caller's waitlist entries.
// POST   /api/driver/onboarding/waitlist — join the TAKEME rental waitlist
//        for a market (idempotent; one live entry per user per market).
// DELETE /api/driver/onboarding/waitlist?marketKey=… — leave the waitlist.
// ═══════════════════════════════════════════════════════════════════════════

const postSchema = z
  .object({
    marketKey: z.string().min(1).max(64),
    vehicleSize: z.enum(['standard', 'large']).default('standard'),
    pickupArea: z.string().trim().max(120).optional(),
    notifyOptIn: z.boolean().default(true),
  })
  .strict();

async function marketByKey(svc: ReturnType<typeof createServiceClient>, key: string) {
  const { data } = await svc
    .from('onboarding_markets')
    .select('id, key, display_name')
    .eq('key', key)
    .maybeSingle();
  return data;
}

export async function GET(request: NextRequest) {
  const { user } = await createApiClient(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const svc = createServiceClient();
  const { data } = await svc
    .from('rental_waitlist')
    .select('id, market_id, vehicle_size, pickup_area, status, notify_opt_in, created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });
  return NextResponse.json({ entries: data ?? [] });
}

export async function POST(request: NextRequest) {
  const limited = await rateLimit(request, 'driver-onboarding');
  if (limited) return limited;

  const { user } = await createApiClient(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = postSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  const body = parsed.data;

  const svc = createServiceClient();
  const market = await marketByKey(svc, body.marketKey);
  if (!market) return NextResponse.json({ error: 'Unknown market' }, { status: 400 });

  const { data: existing } = await svc
    .from('rental_waitlist')
    .select('id, status')
    .eq('user_id', user.id)
    .eq('market_id', market.id)
    .eq('status', 'waiting')
    .maybeSingle();
  if (existing) {
    await svc
      .from('rental_waitlist')
      .update({
        vehicle_size: body.vehicleSize,
        pickup_area: body.pickupArea ?? null,
        notify_opt_in: body.notifyOptIn,
      })
      .eq('id', existing.id);
    return NextResponse.json({ joined: true, updated: true });
  }

  const application = await latestApplication(svc, user.id);
  const { error } = await svc.from('rental_waitlist').insert({
    user_id: user.id,
    application_id: application?.id ?? null,
    market_id: market.id,
    vehicle_size: body.vehicleSize,
    pickup_area: body.pickupArea ?? null,
    notify_opt_in: body.notifyOptIn,
  });
  if (error && error.code !== '23505') {
    return NextResponse.json({ error: 'Could not join the waitlist' }, { status: 500 });
  }
  await logEvent(svc, {
    applicationId: application?.id ?? null,
    userId: user.id,
    actor: 'driver',
    event: 'rental_waitlist_joined',
    detail: { marketKey: market.key, vehicleSize: body.vehicleSize },
  });
  return NextResponse.json({ joined: true, updated: false });
}

export async function DELETE(request: NextRequest) {
  const { user } = await createApiClient(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const marketKey = new URL(request.url).searchParams.get('marketKey');
  if (!marketKey) return NextResponse.json({ error: 'marketKey required' }, { status: 400 });

  const svc = createServiceClient();
  const market = await marketByKey(svc, marketKey);
  if (!market) return NextResponse.json({ error: 'Unknown market' }, { status: 400 });

  await svc
    .from('rental_waitlist')
    .update({ status: 'cancelled' })
    .eq('user_id', user.id)
    .eq('market_id', market.id)
    .eq('status', 'waiting');
  return NextResponse.json({ left: true });
}
