import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getRequestUser } from '@/lib/auth/request-user';
import { createServiceClient } from '@/lib/supabase/service';

// POST /api/push-token — Register or update a push token
const schema = z.object({
  token: z.string().min(1),
  platform: z.enum(['ios', 'android']).default('ios'),
  role: z.enum(['rider', 'driver']).default('rider'),
});

export async function POST(request: NextRequest) {
  try {
    const user = await getRequestUser(request);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = schema.parse(await request.json());
    const svc = createServiceClient();

    await svc.from('push_tokens').upsert({
      user_id: user.id,
      token: body.token,
      platform: body.platform,
      role: body.role,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,role' });

    return NextResponse.json({ registered: true });
  } catch (err) {
    console.error('[push-token]', err);
    return NextResponse.json({ error: 'Failed to register token' }, { status: 500 });
  }
}
