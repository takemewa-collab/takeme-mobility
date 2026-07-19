import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createApiClient } from '@/lib/supabase/api';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimit } from '@/lib/rate-limit';
import { riderPreferenceOptions, SERVICE_ANIMAL_NOTE } from '@/lib/ride-preferences';

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/mobile/ride-options — what preference options this rider may see.
//
// Availability, fee, and copy are server truth from ride_preference_config.
// A preference the market doesn't offer is simply invisible — the client
// never learns about (let alone renders) unavailable options.
//
// v1 state resolution: the client MAY send a stateCode hint, but the default
// (NULL-state) config is authoritative until the server resolves state from
// coordinates itself. lat/lng are accepted now so clients don't need a
// contract change when that lands.
// ═══════════════════════════════════════════════════════════════════════════

const schema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  stateCode: z
    .string()
    .length(2)
    .regex(/^[A-Za-z]{2}$/)
    .transform((s) => s.toUpperCase())
    .optional(),
});

export async function POST(request: NextRequest) {
  try {
    const rateLimited = await rateLimit(request, 'airports');
    if (rateLimited) return rateLimited;

    const { user } = await createApiClient(request);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    let body: z.infer<typeof schema>;
    try {
      body = schema.parse(await request.json());
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    // v1: default market config regardless of the client's stateCode hint —
    // riderPreferenceOptions takes the state so per-market rollout is a
    // one-line change here once server-side state resolution exists.
    void body.stateCode;
    const options = await riderPreferenceOptions(createServiceClient(), user.id, null);

    return NextResponse.json({
      ...options,
      // Rider UI shows this on the options sheet: service animals are never
      // an option, never a fee.
      serviceAnimalNote: SERVICE_ANIMAL_NOTE,
    });
  } catch (err) {
    console.error('POST /api/mobile/ride-options failed:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
