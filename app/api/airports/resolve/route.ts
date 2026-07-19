import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createApiClient } from '@/lib/supabase/api';
import { rateLimit } from '@/lib/rate-limit';
import { resolvePlace } from '@/lib/airports/resolution';

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/airports/resolve
//
// Is this place an airport TAKEME knows? Called by the rider app whenever a
// destination/pickup is chosen. Returns {kind:'normal'} or
// {kind:'airport', airport, flow} — flow says whether the airport booking
// experience is enabled and which directions are available/verified.
// ═══════════════════════════════════════════════════════════════════════════

const requestSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  name: z.string().max(300).optional(),
  mapboxId: z.string().max(200).optional(),
  iata: z.string().max(10).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const rateLimited = await rateLimit(request, 'airports');
    if (rateLimited) return rateLimited;

    const { user } = await createApiClient(request);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    let body: z.infer<typeof requestSchema>;
    try {
      body = requestSchema.parse(await request.json());
    } catch (err) {
      const message = err instanceof z.ZodError
        ? err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
        : 'Invalid request body';
      return NextResponse.json({ error: message }, { status: 400 });
    }

    const resolution = await resolvePlace(body);
    return NextResponse.json(resolution);
  } catch (err) {
    console.error('POST /api/airports/resolve failed:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
