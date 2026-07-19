import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/admin/airports?q=&state=&coverage=&page=
//
// Catalog search for the airport admin console. 50 per page.
// ═══════════════════════════════════════════════════════════════════════════

const PAGE_SIZE = 50;

const COVERAGE_VALUES = new Set([
  'cataloged',
  'passenger_service',
  'serviceable',
  'curated',
  'verified',
  'temporarily_disabled',
]);

export async function GET(request: NextRequest) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const url = request.nextUrl;
  const q = (url.searchParams.get('q') ?? '').replace(/[^a-zA-Z0-9 \-']/g, '').trim().slice(0, 80);
  const state = (url.searchParams.get('state') ?? '').replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 2);
  const coverage = url.searchParams.get('coverage') ?? '';
  const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const svc = createServiceClient();

  try {
    let query = svc
      .from('airports')
      .select(
        'id, iata_code, icao_code, faa_lid, display_name, official_name, municipality, state_code, service_class, enplanements, coverage_status, catalog_status, active, updated_at',
        { count: 'exact' },
      )
      .eq('catalog_status', 'active')
      .order('enplanements', { ascending: false, nullsFirst: false })
      .order('display_name', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (q) {
      const code = q.toUpperCase();
      query = query.or(
        `display_name.ilike.%${q}%,official_name.ilike.%${q}%,municipality.ilike.%${q}%,iata_code.eq.${code},icao_code.eq.${code},faa_lid.eq.${code}`,
      );
    }
    if (state) query = query.eq('state_code', state);
    if (coverage && COVERAGE_VALUES.has(coverage)) query = query.eq('coverage_status', coverage);

    const { data, count, error } = await query;
    if (error) {
      console.error('[admin/airports] query failed:', error.message);
      return NextResponse.json({ error: 'Failed to fetch airports' }, { status: 500 });
    }

    return NextResponse.json({
      airports: data ?? [],
      page,
      page_size: PAGE_SIZE,
      total: count ?? 0,
    });
  } catch (err) {
    console.error('GET /api/admin/airports failed:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
