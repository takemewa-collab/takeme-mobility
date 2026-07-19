import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/admin/airports/imports — last 50 catalog import runs.
// ═══════════════════════════════════════════════════════════════════════════

export async function GET() {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const svc = createServiceClient();

  try {
    const { data, error } = await svc
      .from('airport_data_imports')
      .select('id, source, source_version, effective_date, checksum, status, counts, error_summary, started_at, finished_at')
      .order('started_at', { ascending: false })
      .limit(50);

    if (error) {
      console.error('[admin/airports/imports] query failed:', error.message);
      return NextResponse.json({ error: 'Failed to fetch imports' }, { status: 500 });
    }

    return NextResponse.json({ imports: data ?? [] });
  } catch (err) {
    console.error('GET /api/admin/airports/imports failed:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
