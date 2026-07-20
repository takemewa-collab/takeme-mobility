import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createApiClient } from '@/lib/supabase/api';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimit } from '@/lib/rate-limit';
import {
  getOnboardingBundle,
  latestApplication,
  listMarkets,
  logEvent,
  toClientState,
} from '@/lib/onboarding/service';

// ═══════════════════════════════════════════════════════════════════════════
// GET  /api/driver/onboarding — server-authoritative onboarding state:
//      application, requirement checklist, activation decision, next action.
//      Also returns the market catalog so the app can render the selector.
// POST /api/driver/onboarding — create or update the application: market,
//      applicant type, vehicle relationship, profile fields, optional
//      driving preferences, preferred language.
//
// Optional preference answers are stored separately from compliance data and
// are never inputs to approval, ranking, or pricing decisions.
// ═══════════════════════════════════════════════════════════════════════════

const postSchema = z
  .object({
    marketKey: z.string().min(1).max(64).optional(),
    applicantType: z
      .enum([
        'individual_owner', 'individual_lease', 'rental_seeker',
        'fleet_driver', 'fleet_owner', 'livery_operator', 'subcarrier',
      ])
      .optional(),
    vehicleRelationship: z
      .enum(['personal_owned', 'personal_leased', 'takeme_rental', 'fleet_assigned', 'commercial_livery', 'none'])
      .optional(),
    fullName: z.string().trim().min(1).max(120).optional(),
    email: z.string().trim().email().max(254).optional(),
    phone: z.string().trim().min(7).max(20).optional(),
    licenseNumber: z.string().trim().min(1).max(32).optional(),
    preferredLanguage: z.string().trim().min(2).max(8).optional(),
    preferences: z
      .object({
        weeklyHours: z.enum(['under_10', '10_25', '25_40', 'over_40']).optional(),
        airportInterest: z.boolean().optional(),
        accessibleVehicle: z.boolean().optional(),
        languagesSpoken: z.array(z.string().trim().max(32)).max(10).optional(),
        priorExperience: z.boolean().optional(),
        rentalInterest: z.boolean().optional(),
        preferredAreas: z.array(z.string().trim().max(64)).max(10).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export async function GET(request: NextRequest) {
  const { user } = await createApiClient(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const svc = createServiceClient();
  const [bundle, markets] = await Promise.all([
    getOnboardingBundle(svc, user.id),
    listMarkets(svc),
  ]);
  return NextResponse.json({
    state: toClientState(bundle),
    markets: markets.map((m) => ({
      key: m.key,
      displayName: m.display_name,
      countryCode: m.country_code,
      regionCode: m.region_code,
      city: m.city,
      status: m.status,
    })),
  });
}

export async function POST(request: NextRequest) {
  const limited = await rateLimit(request, 'driver-onboarding');
  if (limited) return limited;

  const { user } = await createApiClient(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = postSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  const body = parsed.data;
  const svc = createServiceClient();

  let marketId: string | undefined;
  let marketChanged = false;
  if (body.marketKey) {
    const { data: market } = await svc
      .from('onboarding_markets')
      .select('id, status')
      .eq('key', body.marketKey)
      .maybeSingle();
    if (!market) return NextResponse.json({ error: 'Unknown market' }, { status: 400 });
    if (market.status === 'inactive') {
      return NextResponse.json({ error: 'Market not available' }, { status: 409 });
    }
    marketId = market.id;
  }

  let application = await latestApplication(svc, user.id);
  if (application && ['rejected', 'suspended'].includes(application.status)) {
    return NextResponse.json(
      { error: 'Your application can no longer be edited. Contact support for help.' },
      { status: 409 },
    );
  }

  const updates: Record<string, unknown> = {};
  if (marketId) {
    marketChanged = Boolean(application && application.market_id && application.market_id !== marketId);
    updates.market_id = marketId;
    updates.city = body.marketKey;
  }
  if (body.applicantType) updates.applicant_type = body.applicantType;
  if (body.vehicleRelationship) updates.vehicle_relationship = body.vehicleRelationship;
  if (body.fullName) updates.full_name = body.fullName;
  if (body.email) updates.email = body.email;
  if (body.phone) updates.phone = body.phone;
  if (body.licenseNumber) updates.license_number = body.licenseNumber;
  if (body.preferredLanguage) updates.preferred_language = body.preferredLanguage;
  if (body.preferences) {
    updates.preferences = { ...(application?.preferences ?? {}), ...body.preferences };
  }

  if (!application) {
    const { data: created, error } = await svc
      .from('driver_applications')
      .insert({
        user_id: user.id,
        full_name: body.fullName ?? '',
        phone: body.phone ?? '',
        email: body.email ?? null,
        license_number: body.licenseNumber ?? '',
        status: 'in_progress',
        ...updates,
      })
      .select('*')
      .single();
    if (error || !created) {
      console.error('[onboarding] application insert failed:', error?.message);
      return NextResponse.json({ error: 'Could not start application' }, { status: 500 });
    }
    application = created;
    await logEvent(svc, {
      applicationId: created.id,
      userId: user.id,
      actor: 'driver',
      event: 'application_started',
      detail: { marketKey: body.marketKey ?? null },
    });
  } else if (Object.keys(updates).length > 0) {
    const { error } = await svc
      .from('driver_applications')
      .update(updates)
      .eq('id', application.id);
    if (error) {
      return NextResponse.json({ error: 'Could not save changes' }, { status: 500 });
    }
    if (marketChanged || body.applicantType || body.vehicleRelationship) {
      await logEvent(svc, {
        applicationId: application.id,
        userId: user.id,
        actor: 'driver',
        event: marketChanged ? 'market_changed' : 'application_updated',
        detail: {
          marketKey: body.marketKey ?? null,
          applicantType: body.applicantType ?? null,
          vehicleRelationship: body.vehicleRelationship ?? null,
        },
      });
    }
  }

  const bundle = await getOnboardingBundle(svc, user.id);
  return NextResponse.json({ state: toClientState(bundle), marketChanged });
}
