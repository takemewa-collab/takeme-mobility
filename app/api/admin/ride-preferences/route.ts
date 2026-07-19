import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';
import { logAdminAction } from '@/lib/admin-audit';
import { clearPreferenceCache } from '@/lib/ride-preferences';

// ═══════════════════════════════════════════════════════════════════════════
// GET  /api/admin/ride-preferences — config rows + aggregate driver counts.
// POST /api/admin/ride-preferences — upsert a config row, or manage Women
//      Preferred invitations ({action: 'invite_driver'|'uninvite_driver'}).
//
// Every write is audit-logged (019) and invalidates the server config cache.
// Driver data leaves here as aggregate NUMBERS only — no per-driver lists.
// ═══════════════════════════════════════════════════════════════════════════

const configSchema = z
  .object({
    preference: z.enum(['women_preferred', 'pet_friendly']),
    stateCode: z
      .string()
      .length(2)
      .regex(/^[A-Za-z]{2}$/)
      .transform((s) => s.toUpperCase())
      .nullish(),
    enabled: z.boolean(),
    fee: z.number().min(0).max(100).nullish(),
    feeEffectiveFrom: z.string().datetime({ offset: true }).nullish(),
    feeEffectiveTo: z.string().datetime({ offset: true }).nullish(),
    rules: z.record(z.string(), z.unknown()).optional(),
    copyVersion: z.string().max(40).nullish(),
    fallbackDefault: z.enum(['keep_looking', 'any_driver']).optional(),
  })
  .strict();

const inviteSchema = z
  .object({
    action: z.enum(['invite_driver', 'uninvite_driver']),
    driverId: z.string().uuid(),
  })
  .strict();

export async function GET() {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const svc = createServiceClient();
  try {
    const [configRes, optInRes, invitedRes, enrolledRes] = await Promise.all([
      svc
        .from('ride_preference_config')
        .select(
          'id, preference, state_code, enabled, fee, fee_effective_from, fee_effective_to, rules, copy_version, fallback_default, active, created_at, updated_at',
        )
        .order('preference')
        .order('state_code', { ascending: true, nullsFirst: true }),
      svc
        .from('drivers')
        .select('id', { count: 'exact', head: true })
        .eq('pet_friendly_opt_in', true),
      svc
        .from('drivers')
        .select('id', { count: 'exact', head: true })
        .eq('women_preferred_invited', true),
      svc
        .from('drivers')
        .select('id', { count: 'exact', head: true })
        .eq('women_preferred_enrolled', true),
    ]);

    if (configRes.error) {
      console.error('[admin/ride-preferences] config query failed:', configRes.error.message);
      return NextResponse.json({ error: 'Failed to load config' }, { status: 500 });
    }

    return NextResponse.json({
      config: configRes.data ?? [],
      driverCounts: {
        petFriendlyOptIn: optInRes.count ?? 0,
        womenPreferredInvited: invitedRes.count ?? 0,
        womenPreferredEnrolled: enrolledRes.count ?? 0,
      },
    });
  } catch (err) {
    console.error('GET /api/admin/ride-preferences failed:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  const admin = auth.user;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const svc = createServiceClient();

  try {
    // ── Invitation management ────────────────────────────────────────────
    const maybeAction = (raw as { action?: unknown })?.action;
    if (maybeAction === 'invite_driver' || maybeAction === 'uninvite_driver') {
      const parsed = inviteSchema.safeParse(raw);
      if (!parsed.success) {
        return NextResponse.json({ error: 'Invalid invitation request' }, { status: 400 });
      }
      const { action, driverId } = parsed.data;

      const update =
        action === 'invite_driver'
          ? { women_preferred_invited: true }
          : {
              // Withdrawing an invitation also clears any enrollment consent.
              women_preferred_invited: false,
              women_preferred_enrolled: false,
              women_preferred_enrolled_at: null,
            };

      const { data: updated, error } = await svc
        .from('drivers')
        .update(update)
        .eq('id', driverId)
        .select('id')
        .maybeSingle();

      if (error) {
        console.error('[admin/ride-preferences] invitation update failed:', error.message);
        return NextResponse.json({ error: 'Update failed' }, { status: 500 });
      }
      if (!updated) {
        return NextResponse.json({ error: 'Driver not found' }, { status: 404 });
      }

      await logAdminAction({
        adminId: admin.id,
        adminEmail: admin.email,
        action:
          action === 'invite_driver' ? 'women_preferred_invite' : 'women_preferred_uninvite',
        targetType: 'driver',
        targetId: driverId,
        details: { program: 'women_preferred' },
        ipAddress: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? undefined,
      });

      return NextResponse.json({ ok: true, driverId, invited: action === 'invite_driver' });
    }

    // ── Config upsert ────────────────────────────────────────────────────
    const parsed = configSchema.safeParse(raw);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      return NextResponse.json({ error: message }, { status: 400 });
    }
    const body = parsed.data;
    const stateCode = body.stateCode ?? null;

    const row = {
      preference: body.preference,
      state_code: stateCode,
      enabled: body.enabled,
      fee: body.fee ?? null,
      fee_effective_from: body.feeEffectiveFrom ?? null,
      fee_effective_to: body.feeEffectiveTo ?? null,
      rules: body.rules ?? {},
      copy_version: body.copyVersion ?? null,
      fallback_default: body.fallbackDefault ?? 'any_driver',
      active: true,
    };

    // One active row per (preference, state_code): update it in place when it
    // exists, insert otherwise (the partial unique index backstops races).
    let existingQuery = svc
      .from('ride_preference_config')
      .select('id')
      .eq('preference', body.preference)
      .eq('active', true);
    existingQuery = stateCode
      ? existingQuery.eq('state_code', stateCode)
      : existingQuery.is('state_code', null);
    const { data: existing } = await existingQuery.maybeSingle();

    const result = existing
      ? await svc
          .from('ride_preference_config')
          .update(row)
          .eq('id', existing.id)
          .select('id')
          .single()
      : await svc.from('ride_preference_config').insert(row).select('id').single();

    if (result.error || !result.data) {
      console.error('[admin/ride-preferences] upsert failed:', result.error?.message);
      return NextResponse.json({ error: 'Save failed' }, { status: 500 });
    }

    await logAdminAction({
      adminId: admin.id,
      adminEmail: admin.email,
      action: 'ride_preference_config_upsert',
      targetType: 'system',
      targetId: result.data.id,
      details: row,
      ipAddress: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? undefined,
    });

    // Config changed — riders and rides/create must see it now, not in 5 min.
    clearPreferenceCache();

    return NextResponse.json({ ok: true, id: result.data.id });
  } catch (err) {
    console.error('POST /api/admin/ride-preferences failed:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
