import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';
import { clearAirportCache } from '@/lib/airports/resolution';

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/admin/airports/[id]/publish
//
// Atomic publish via publish_airport_config() (SECURITY DEFINER, 044):
// verifies the explicitly listed terminals / service points / assignments and
// optionally promotes coverage_status in ONE transaction. The DB triggers
// keep enforcing integrity (verified floor, assignment types, no-centroid).
// Records a 'published' revision and clears the bounded config cache.
// ═══════════════════════════════════════════════════════════════════════════

type RouteContext = { params: Promise<{ id: string }> };

const idSchema = z.string().uuid();

const requestSchema = z.object({
  note: z.string().max(1000).optional(),
  terminalIds: z.array(idSchema).max(200).optional(),
  servicePointIds: z.array(idSchema).max(500).optional(),
  assignmentIds: z.array(idSchema).max(500).optional(),
  coverageStatus: z
    .enum(['cataloged', 'passenger_service', 'serviceable', 'curated', 'verified', 'temporarily_disabled'])
    .optional(),
});

export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const { id } = await ctx.params;
  if (!idSchema.safeParse(id).success) {
    return NextResponse.json({ error: 'Invalid airport id' }, { status: 400 });
  }

  let body: z.infer<typeof requestSchema>;
  try {
    body = requestSchema.parse(await request.json());
  } catch (err) {
    const message = err instanceof z.ZodError
      ? err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
      : 'Invalid request body';
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const svc = createServiceClient();

  try {
    const { data: summary, error } = await svc.rpc('publish_airport_config', {
      p_airport: id,
      p_terminals: body.terminalIds ?? [],
      p_service_points: body.servicePointIds ?? [],
      p_assignments: body.assignmentIds ?? [],
      p_coverage: body.coverageStatus ?? null,
    });

    if (error) {
      // Trigger/validation failures surface as named exceptions — return the
      // message so the console can explain (e.g. verified_requires_*).
      const message = error.message.includes('airport_not_found')
        ? 'Airport not found'
        : `Publish failed: ${error.message}`;
      const status = error.message.includes('airport_not_found') ? 404 : 409;
      return NextResponse.json({ error: message }, { status });
    }

    const editor = auth.user.email || auth.user.id;
    const { error: revisionError } = await svc.from('airport_data_revisions').insert({
      entity_type: 'airport',
      entity_id: id,
      state: 'published',
      before: null,
      after: {
        airport_id: id,
        summary,
        note: body.note ?? null,
        terminal_ids: body.terminalIds ?? [],
        service_point_ids: body.servicePointIds ?? [],
        assignment_ids: body.assignmentIds ?? [],
        coverage_status: body.coverageStatus ?? null,
      },
      editor,
      published_at: new Date().toISOString(),
    });
    if (revisionError) {
      console.error('[admin/airports/publish] revision record failed:', revisionError.message);
    }

    clearAirportCache(id);
    return NextResponse.json({ published: true, summary });
  } catch (err) {
    console.error('POST /api/admin/airports/[id]/publish failed:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
