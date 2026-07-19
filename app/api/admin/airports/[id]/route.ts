import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';
import { clearAirportCache, normalizePlaceName } from '@/lib/airports/resolution';

// ═══════════════════════════════════════════════════════════════════════════
// GET  /api/admin/airports/[id]  — full airport detail for the admin console
// POST /api/admin/airports/[id]  — draft upsert/deactivate of one child entity
//
// Draft semantics: any create/edit of a terminal / service point / assignment
// lands with verified=false — an edited row loses its verified badge until
// the next publish. Every mutation is recorded in airport_data_revisions
// (state 'draft'); publish (sibling route) records 'published'.
// ═══════════════════════════════════════════════════════════════════════════

type RouteContext = { params: Promise<{ id: string }> };

const idSchema = z.string().uuid();
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// ── GET: full detail ─────────────────────────────────────────────────────

export async function GET(_req: NextRequest, ctx: RouteContext) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const { id } = await ctx.params;
  if (!idSchema.safeParse(id).success) {
    return NextResponse.json({ error: 'Invalid airport id' }, { status: 400 });
  }

  const svc = createServiceClient();

  try {
    const [
      airportRes,
      identifiersRes,
      terminalsRes,
      pointsRes,
      airlineServicesRes,
      assignmentsRes,
      instructionsRes,
      rulesRes,
      revisionsRes,
      importsRes,
    ] = await Promise.all([
      svc.from('airports').select('*').eq('id', id).single(),
      svc.from('airport_identifiers').select('*').eq('airport_id', id).order('identifier_type').limit(200),
      svc.from('airport_terminals').select('*').eq('airport_id', id).order('display_order').limit(200),
      svc.from('airport_service_points').select('*').eq('airport_id', id).order('point_type').limit(500),
      svc
        .from('airport_airline_services')
        .select('*, airlines ( id, display_name, iata_code, active )')
        .eq('airport_id', id)
        .order('popularity_rank', { ascending: true, nullsFirst: false })
        .limit(500),
      svc
        .from('airport_airline_assignments')
        .select('*, airlines ( id, display_name, iata_code )')
        .eq('airport_id', id)
        .limit(500),
      svc.from('airport_instructions').select('*').eq('airport_id', id).order('display_order').limit(500),
      svc.from('airport_rules').select('*').eq('airport_id', id).limit(200),
      svc
        .from('airport_data_revisions')
        .select('id, entity_type, entity_id, state, before, after, editor, reviewer, created_at, published_at')
        .or(`entity_id.eq.${id},after->>airport_id.eq.${id},before->>airport_id.eq.${id}`)
        .order('created_at', { ascending: false })
        .limit(10),
      svc
        .from('airport_data_imports')
        .select('id, source, source_version, effective_date, status, counts, started_at, finished_at')
        .order('started_at', { ascending: false })
        .limit(10),
    ]);

    if (airportRes.error || !airportRes.data) {
      return NextResponse.json({ error: 'Airport not found' }, { status: 404 });
    }

    return NextResponse.json({
      airport: airportRes.data,
      identifiers: identifiersRes.data ?? [],
      terminals: terminalsRes.data ?? [],
      service_points: pointsRes.data ?? [],
      airline_services: airlineServicesRes.data ?? [],
      assignments: assignmentsRes.data ?? [],
      instructions: instructionsRes.data ?? [],
      rules: rulesRes.data ?? [],
      revisions: revisionsRes.data ?? [],
      imports: importsRes.data ?? [],
    });
  } catch (err) {
    console.error('GET /api/admin/airports/[id] failed:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}

// ── POST: draft mutation of one entity ───────────────────────────────────

const latSchema = z.number().min(-90).max(90);
const lngSchema = z.number().min(-180).max(180);

const airportDataSchema = z.object({
  display_name: z.string().min(1).max(200).optional(),
  municipality: z.string().max(200).nullable().optional(),
  timezone: z.string().max(64).nullable().optional(),
  state_code: z.string().length(2).nullable().optional(),
  detection_radius_m: z.number().int().min(100).max(15000).optional(),
  service_class: z
    .enum(['large_hub', 'medium_hub', 'small_hub', 'nonhub_primary', 'nonprimary_commercial', 'reliever', 'general_aviation', 'unclassified'])
    .optional(),
  active: z.boolean().optional(),
});

const terminalDataSchema = z.object({
  id: idSchema.optional(),
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(200),
  display_order: z.number().int().min(0).max(1000).optional(),
  lat: latSchema.nullable().optional(),
  lng: lngSchema.nullable().optional(),
});

const servicePointDataSchema = z.object({
  id: idSchema.optional(),
  terminal_id: idSchema.nullable().optional(),
  point_type: z.enum(['general_departures_dropoff', 'airline_departures_dropoff', 'rideshare_pickup', 'arrivals_reference']),
  name: z.string().min(1).max(200),
  lat: latSchema,
  lng: lngSchema,
  level: z.string().max(80).nullable().optional(),
  door: z.string().max(80).nullable().optional(),
  zone: z.string().max(80).nullable().optional(),
  island: z.string().max(80).nullable().optional(),
  accessibility: z.string().max(500).nullable().optional(),
  restrictions: z.string().max(500).nullable().optional(),
  // Free-form operating-hours note (the admin UI writes {note}); structured
  // schedules can extend this object without a schema break.
  hours: z.object({ note: z.string().max(500).optional() }).optional(),
});

const assignmentDataSchema = z.object({
  id: idSchema.optional(),
  airline_id: idSchema,
  terminal_id: idSchema.nullable().optional(),
  departures_service_point_id: idSchema.nullable().optional(),
  arrivals_service_point_id: idSchema.nullable().optional(),
  effective_from: dateSchema.nullable().optional(),
  effective_to: dateSchema.nullable().optional(),
});

const instructionDataSchema = z.object({
  id: idSchema.optional(),
  service_point_id: idSchema.nullable().optional(),
  audience: z.enum(['rider', 'driver', 'both']),
  direction: z.enum(['pickup', 'dropoff']),
  locale: z.string().max(10).optional(),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(2000),
  image_url: z.string().url().max(500).nullable().optional(),
  display_order: z.number().int().min(0).max(1000).optional(),
});

const ruleDataSchema = z.object({
  id: idSchema.optional(),
  rule_type: z.enum(['airport_fee', 'pickup_wait', 'geofence_rule', 'access_restriction', 'custom']),
  config: z.record(z.string(), z.unknown()),
  effective_from: dateSchema.nullable().optional(),
  effective_to: dateSchema.nullable().optional(),
});

const identifierDataSchema = z.object({
  id: idSchema.optional(),
  identifier_type: z.enum(['faa_lid', 'iata', 'icao', 'mapbox_place', 'google_place', 'alias_normalized']),
  identifier_value: z.string().min(1).max(200),
  provider: z.string().max(80).nullable().optional(),
});

const airlineServiceDataSchema = z.object({
  id: idSchema.optional(),
  airline_id: idSchema,
  popularity_rank: z.number().int().min(1).max(1000).nullable().optional(),
  popularity_score: z.number().min(0).nullable().optional(),
  reporting_period: z.string().max(80).nullable().optional(),
});

const mutationSchema = z.object({
  entity: z.enum(['airport', 'terminal', 'service_point', 'assignment', 'instruction', 'rule', 'identifier', 'airline_service']),
  action: z.enum(['upsert', 'deactivate']),
  data: z.record(z.string(), z.unknown()),
});

const ENTITY_TABLES: Record<string, string> = {
  airport: 'airports',
  terminal: 'airport_terminals',
  service_point: 'airport_service_points',
  assignment: 'airport_airline_assignments',
  instruction: 'airport_instructions',
  rule: 'airport_rules',
  identifier: 'airport_identifiers',
  airline_service: 'airport_airline_services',
};

/** Entities whose rows carry a verified flag — drafts always land unverified. */
const VERIFIABLE = new Set(['terminal', 'service_point', 'assignment']);

const airportFeeConfigSchema = z.object({
  amount: z.number().min(0).max(100),
  currency: z.string().regex(/^[A-Za-z]{3}$/),
  direction: z.enum(['pickup', 'dropoff', 'both']),
});

export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const { id: airportId } = await ctx.params;
  if (!idSchema.safeParse(airportId).success) {
    return NextResponse.json({ error: 'Invalid airport id' }, { status: 400 });
  }

  let mutation: z.infer<typeof mutationSchema>;
  try {
    mutation = mutationSchema.parse(await request.json());
  } catch (err) {
    const message = err instanceof z.ZodError
      ? err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
      : 'Invalid request body';
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const svc = createServiceClient();
  const table = ENTITY_TABLES[mutation.entity];
  const editor = auth.user.email || auth.user.id;

  try {
    // The airport must exist (and anchors every child mutation).
    const { data: airport } = await svc.from('airports').select('id').eq('id', airportId).maybeSingle();
    if (!airport) return NextResponse.json({ error: 'Airport not found' }, { status: 404 });

    // ── The airport row itself ─────────────────────────────────────────
    if (mutation.entity === 'airport') {
      const parsed = airportDataSchema.safeParse(mutation.data);
      if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.issues.map(i => i.message).join('; ') }, { status: 400 });
      }
      const patch: Record<string, unknown> =
        mutation.action === 'deactivate' ? { active: false } : { ...parsed.data };
      if (Object.keys(patch).length === 0) {
        return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
      }

      const { data: before } = await svc.from('airports').select('*').eq('id', airportId).single();
      const { data: after, error } = await svc
        .from('airports')
        .update(patch)
        .eq('id', airportId)
        .select('*')
        .single();
      if (error || !after) {
        return NextResponse.json({ error: error?.message ?? 'Update failed' }, { status: 400 });
      }

      await recordRevision(svc, 'airport', airportId, before, after, editor);
      clearAirportCache(airportId);
      return NextResponse.json({ row: after });
    }

    // ── Child entities ─────────────────────────────────────────────────
    let data: Record<string, unknown>;
    switch (mutation.entity) {
      case 'terminal': {
        const p = terminalDataSchema.safeParse(mutation.data);
        if (!p.success) return zodFail(p.error);
        data = p.data;
        break;
      }
      case 'service_point': {
        const p = servicePointDataSchema.safeParse(mutation.data);
        if (!p.success) return zodFail(p.error);
        data = p.data;
        // A referenced terminal must belong to this airport.
        if (p.data.terminal_id) {
          const ok = await belongsToAirport(svc, 'airport_terminals', p.data.terminal_id, airportId);
          if (!ok) return NextResponse.json({ error: 'terminal_id is not a terminal of this airport' }, { status: 400 });
        }
        break;
      }
      case 'assignment': {
        const p = assignmentDataSchema.safeParse(mutation.data);
        if (!p.success) return zodFail(p.error);
        data = p.data;
        // DB trigger check_airline_assignment enforces point/terminal integrity.
        break;
      }
      case 'instruction': {
        const p = instructionDataSchema.safeParse(mutation.data);
        if (!p.success) return zodFail(p.error);
        data = p.data;
        if (p.data.service_point_id) {
          const ok = await belongsToAirport(svc, 'airport_service_points', p.data.service_point_id, airportId);
          if (!ok) return NextResponse.json({ error: 'service_point_id is not a point of this airport' }, { status: 400 });
        }
        break;
      }
      case 'rule': {
        const p = ruleDataSchema.safeParse(mutation.data);
        if (!p.success) return zodFail(p.error);
        if (p.data.rule_type === 'airport_fee') {
          const cfg = airportFeeConfigSchema.safeParse(p.data.config);
          if (!cfg.success) {
            return NextResponse.json(
              { error: 'airport_fee config must be {amount: 0..100, currency: 3-letter, direction: pickup|dropoff|both}' },
              { status: 400 },
            );
          }
          p.data.config = { ...cfg.data, currency: cfg.data.currency.toUpperCase() };
        }
        data = p.data;
        break;
      }
      case 'identifier': {
        const p = identifierDataSchema.safeParse(mutation.data);
        if (!p.success) return zodFail(p.error);
        data = p.data;
        if (p.data.identifier_type === 'alias_normalized') {
          data.identifier_value = normalizePlaceName(p.data.identifier_value);
          if (!data.identifier_value) {
            return NextResponse.json({ error: 'Alias normalizes to an empty value' }, { status: 400 });
          }
        }
        break;
      }
      case 'airline_service': {
        const p = airlineServiceDataSchema.safeParse(mutation.data);
        if (!p.success) return zodFail(p.error);
        data = p.data;
        break;
      }
      default:
        return NextResponse.json({ error: 'Unsupported entity' }, { status: 400 });
    }

    const entityId = typeof data.id === 'string' ? data.id : null;
    const row: Record<string, unknown> = { ...data };
    delete row.id;
    row.airport_id = airportId; // NEVER trust the payload's airport scope

    if (mutation.action === 'deactivate') {
      if (!entityId) {
        return NextResponse.json({ error: 'id is required to deactivate' }, { status: 400 });
      }
      const { data: before } = await svc.from(table).select('*').eq('id', entityId).eq('airport_id', airportId).maybeSingle();
      if (!before) return NextResponse.json({ error: 'Row not found for this airport' }, { status: 404 });

      const { data: after, error } = await svc
        .from(table)
        .update({ active: false })
        .eq('id', entityId)
        .eq('airport_id', airportId)
        .select('*')
        .single();
      if (error || !after) {
        return NextResponse.json({ error: error?.message ?? 'Deactivate failed' }, { status: 400 });
      }

      await recordRevision(svc, mutation.entity, entityId, before, after, editor);
      clearAirportCache(airportId);
      return NextResponse.json({ row: after });
    }

    // Upsert. New and edited verifiable rows always land as drafts.
    if (VERIFIABLE.has(mutation.entity)) row.verified = false;

    if (entityId) {
      const { data: before } = await svc.from(table).select('*').eq('id', entityId).eq('airport_id', airportId).maybeSingle();
      if (!before) return NextResponse.json({ error: 'Row not found for this airport' }, { status: 404 });

      const { data: after, error } = await svc
        .from(table)
        .update(row)
        .eq('id', entityId)
        .eq('airport_id', airportId)
        .select('*')
        .single();
      if (error || !after) {
        return NextResponse.json({ error: error?.message ?? 'Update failed' }, { status: 400 });
      }

      await recordRevision(svc, mutation.entity, entityId, before, after, editor);
      clearAirportCache(airportId);
      return NextResponse.json({ row: after });
    }

    const { data: after, error } = await svc.from(table).insert(row).select('*').single();
    if (error || !after) {
      return NextResponse.json({ error: error?.message ?? 'Insert failed' }, { status: 400 });
    }

    await recordRevision(svc, mutation.entity, (after as { id: string }).id, null, after, editor);
    clearAirportCache(airportId);
    return NextResponse.json({ row: after }, { status: 201 });
  } catch (err) {
    console.error('POST /api/admin/airports/[id] failed:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

function zodFail(error: z.ZodError): NextResponse {
  return NextResponse.json(
    { error: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') },
    { status: 400 },
  );
}

async function belongsToAirport(
  svc: ReturnType<typeof createServiceClient>,
  table: string,
  rowId: string,
  airportId: string,
): Promise<boolean> {
  const { data } = await svc.from(table).select('id').eq('id', rowId).eq('airport_id', airportId).maybeSingle();
  return Boolean(data);
}

async function recordRevision(
  svc: ReturnType<typeof createServiceClient>,
  entityType: string,
  entityId: string,
  before: unknown,
  after: unknown,
  editor: string,
): Promise<void> {
  const { error } = await svc.from('airport_data_revisions').insert({
    entity_type: entityType,
    entity_id: entityId,
    state: 'draft',
    before: before ?? null,
    after: after ?? null,
    editor,
  });
  if (error) console.error('[admin/airports] revision record failed:', error.message);
}
