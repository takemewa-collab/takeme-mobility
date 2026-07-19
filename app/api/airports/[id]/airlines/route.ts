import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createApiClient } from '@/lib/supabase/api';
import { rateLimit } from '@/lib/rate-limit';
import { searchAirportAirlines } from '@/lib/airports/resolution';

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/airports/[id]/airlines?q=
//
// Active airlines serving one airport, ranked by popularity then name. With
// ?q= it's a bounded search (≤50); without, the same ordering untruncated by
// query, still capped at 50.
// ═══════════════════════════════════════════════════════════════════════════

type RouteContext = { params: Promise<{ id: string }> };

const idSchema = z.string().uuid();

export async function GET(request: NextRequest, ctx: RouteContext) {
  try {
    const rateLimited = await rateLimit(request, 'airports');
    if (rateLimited) return rateLimited;

    const { user } = await createApiClient(request);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await ctx.params;
    if (!idSchema.safeParse(id).success) {
      return NextResponse.json({ error: 'Invalid airport id' }, { status: 400 });
    }

    const q = request.nextUrl.searchParams.get('q') ?? '';
    const airlines = await searchAirportAirlines(id, q);

    return NextResponse.json(
      { airlines: airlines.slice(0, 50) },
      { headers: { 'Cache-Control': 'private, max-age=300' } },
    );
  } catch (err) {
    console.error('GET /api/airports/[id]/airlines failed:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
