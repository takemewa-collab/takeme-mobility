import { NextRequest, NextResponse } from 'next/server';
import { createApiClient } from '@/lib/supabase/api';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimit } from '@/lib/rate-limit';

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/airlines?q=
//
// Global active airline search (flight-details flow when there is no airport
// context yet). Bounded to 50 results.
// ═══════════════════════════════════════════════════════════════════════════

export async function GET(request: NextRequest) {
  try {
    const rateLimited = await rateLimit(request, 'airports');
    if (rateLimited) return rateLimited;

    const { user } = await createApiClient(request);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const raw = request.nextUrl.searchParams.get('q') ?? '';
    const term = raw.replace(/[^a-zA-Z0-9 \-']/g, '').trim().slice(0, 50);

    const svc = createServiceClient();
    let query = svc
      .from('airlines')
      .select('id, display_name, iata_code')
      .eq('active', true)
      .order('display_name', { ascending: true })
      .limit(50);

    if (term) {
      query = query.or(`display_name.ilike.%${term}%,iata_code.ilike.${term}`);
    }

    const { data, error } = await query;
    if (error) {
      console.error('[airlines] search failed:', error.message);
      return NextResponse.json({ error: 'Server error' }, { status: 500 });
    }

    return NextResponse.json(
      { airlines: data ?? [] },
      { headers: { 'Cache-Control': 'private, max-age=300' } },
    );
  } catch (err) {
    console.error('GET /api/airlines failed:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
