import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createApiClient } from '@/lib/supabase/api';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimit } from '@/lib/rate-limit';
import { checkEvEligibility } from '@/lib/onboarding/ev-eligibility';
import { decodeVin, normalizePlate, normalizeVin } from '@/lib/onboarding/vin';
import {
  getOnboardingBundle,
  latestApplication,
  logEvent,
  toClientState,
} from '@/lib/onboarding/service';
import type { EvPolicy, VehicleFacts } from '@/lib/onboarding/types';

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/driver/onboarding/vehicle — submit vehicle identity.
// VIN-first: decode through the provider abstraction (NHTSA vPIC), verify
// battery-electric eligibility against the market policy, and guard against
// duplicate active vehicles. Manual fields are a fallback that routes to
// review — a decode outage never hard-blocks the application.
// ═══════════════════════════════════════════════════════════════════════════

const schema = z
  .object({
    vin: z.string().trim().min(11).max(20).optional(),
    plate: z.string().trim().min(2).max(12),
    plateConfirm: z.string().trim().min(2).max(12),
    plateState: z.string().trim().length(2),
    // Manual fallback (used when VIN decode is unavailable):
    make: z.string().trim().max(40).optional(),
    model: z.string().trim().max(60).optional(),
    year: z.number().int().min(1990).max(2100).optional(),
    color: z.string().trim().max(24).optional(),
    doors: z.number().int().min(2).max(6).optional(),
    seatbelts: z.number().int().min(1).max(9).optional(),
  })
  .strict();

export async function POST(request: NextRequest) {
  const limited = await rateLimit(request, 'driver-onboarding');
  if (limited) return limited;

  const { user } = await createApiClient(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  const body = parsed.data;

  const plate = normalizePlate(body.plate);
  const plateConfirm = normalizePlate(body.plateConfirm);
  if (!plate || plate !== plateConfirm) {
    return NextResponse.json(
      { error: 'License plate entries do not match.' },
      { status: 400 },
    );
  }
  const plateState = body.plateState.toUpperCase();

  const svc = createServiceClient();
  const application = await latestApplication(svc, user.id);
  if (!application || !['in_progress', 'pending'].includes(application.status)) {
    return NextResponse.json({ error: 'No editable application' }, { status: 409 });
  }

  let vin: string | null = null;
  if (body.vin) {
    vin = normalizeVin(body.vin);
    if (!vin) {
      return NextResponse.json(
        { error: 'That VIN is not valid. VINs are 17 characters and never contain I, O, or Q.' },
        { status: 400 },
      );
    }
  }

  // Duplicate protection against active fleet — before any provider calls.
  const dupQuery = svc
    .from('vehicles')
    .select('id, driver_id')
    .eq('is_active', true);
  const { data: plateDupes } = await dupQuery
    .eq('plate_state', plateState)
    .ilike('plate_number', plate);
  const ownDriver = await svc
    .from('drivers')
    .select('id')
    .eq('auth_user_id', user.id)
    .maybeSingle();
  const foreignPlateDupe = (plateDupes ?? []).some((v) => v.driver_id !== ownDriver.data?.id);
  let foreignVinDupe = false;
  if (vin) {
    const { data: vinDupes } = await svc
      .from('vehicles')
      .select('id, driver_id')
      .eq('is_active', true)
      .ilike('vin', vin);
    foreignVinDupe = (vinDupes ?? []).some((v) => v.driver_id !== ownDriver.data?.id);
  }
  if (foreignPlateDupe || foreignVinDupe) {
    return NextResponse.json(
      { error: 'This vehicle is already active on another TAKEME account. Contact support if you believe this is a mistake.' },
      { status: 409 },
    );
  }

  // Decode + eligibility.
  let facts: VehicleFacts = {
    vin,
    make: body.make ?? null,
    model: body.model ?? null,
    year: body.year ?? null,
    doors: body.doors ?? null,
    seatbelts: body.seatbelts ?? null,
    powertrain: 'unknown',
    bodyType: null,
  };
  let decodeSource: string = 'manual';
  if (vin) {
    const decoded = await decodeVin(vin);
    if (decoded.ok && decoded.facts) {
      decodeSource = decoded.source;
      facts = {
        ...facts,
        ...Object.fromEntries(
          Object.entries(decoded.facts).filter(([, v]) => v != null),
        ),
      } as VehicleFacts;
    }
  }

  let policy: EvPolicy = {};
  if (application.market_id) {
    const { data: market } = await svc
      .from('onboarding_markets')
      .select('policies')
      .eq('id', application.market_id)
      .maybeSingle();
    policy = (market?.policies?.ev ?? {}) as EvPolicy;
  }
  const eligibility = checkEvEligibility(facts, policy, new Date());

  const verification = {
    eligible: eligibility.eligible,
    needsReview: eligibility.needsReview,
    reasons: eligibility.reasons,
    source: decodeSource,
    checkedAt: new Date().toISOString(),
    facts: {
      make: facts.make,
      model: facts.model,
      year: facts.year,
      doors: facts.doors,
      seatbelts: facts.seatbelts,
      powertrain: facts.powertrain,
      bodyType: facts.bodyType,
    },
  };

  const { error } = await svc
    .from('driver_applications')
    .update({
      vin,
      plate_number: plate,
      plate_state: plateState,
      vehicle_make: facts.make,
      vehicle_model: facts.model,
      vehicle_year: facts.year,
      vehicle_color: body.color ?? application.vehicle_color,
      doors: facts.doors,
      seatbelts: facts.seatbelts,
      powertrain: facts.powertrain,
      body_type: facts.bodyType,
      vehicle_verification: verification,
    })
    .eq('id', application.id);
  if (error) {
    return NextResponse.json({ error: 'Could not save vehicle' }, { status: 500 });
  }

  await logEvent(svc, {
    applicationId: application.id,
    userId: user.id,
    actor: 'driver',
    event: 'vehicle_submitted',
    detail: {
      source: decodeSource,
      eligible: eligibility.eligible,
      needsReview: eligibility.needsReview,
      reasons: eligibility.reasons,
    },
  });

  const bundle = await getOnboardingBundle(svc, user.id);
  return NextResponse.json({
    state: toClientState(bundle),
    vehicle: {
      decoded: decodeSource !== 'manual',
      eligibility: {
        eligible: eligibility.eligible,
        needsReview: eligibility.needsReview,
        reasons: eligibility.reasons,
      },
      facts: verification.facts,
    },
  });
}
