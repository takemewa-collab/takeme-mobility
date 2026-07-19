import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createApiClient } from '@/lib/supabase/api';
import { rateLimit } from '@/lib/rate-limit';
import {
  airportFeeDetail,
  flowFor,
  getAirportConfig,
  instructionsFor,
  popularAirlines,
  resolveGeneralFallback,
  type ServicePointRecord,
} from '@/lib/airports/resolution';

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/airports/[id]/config
//
// The published airport experience for the rider app: terminals, popular
// airlines, the general drop-off summary, the rideshare pickup zone with its
// rider instructions, and the airport fee. Active/published rows only — no
// drafts, no source jsonb, no import metadata ever leave the server.
// ═══════════════════════════════════════════════════════════════════════════

type RouteContext = { params: Promise<{ id: string }> };

const idSchema = z.string().uuid();

function pointSummary(point: ServicePointRecord) {
  return {
    id: point.id,
    point_type: point.point_type,
    name: point.name,
    lat: point.lat,
    lng: point.lng,
    level: point.level,
    door: point.door,
    zone: point.zone,
    island: point.island,
    verified: point.verified,
  };
}

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

    const config = await getAirportConfig(id);
    if (!config || !config.airport.active) {
      return NextResponse.json({ error: 'Airport not found' }, { status: 404 });
    }

    const [airlines, generalDropoff, ridesharePickup, fee] = await Promise.all([
      popularAirlines(id, 8),
      resolveGeneralFallback(id, 'airport_dropoff'),
      resolveGeneralFallback(id, 'airport_pickup'),
      airportFeeDetail(id, 'airport_dropoff').then(
        (dropoffFee) => dropoffFee ?? airportFeeDetail(id, 'airport_pickup'),
      ),
    ]);

    const pickupInstructions = ridesharePickup
      ? await instructionsFor(id, ridesharePickup.servicePoint.id, 'airport_pickup', 'rider')
      : [];

    // config_version: newest updated_at across everything the client renders.
    let maxMs = Date.parse(config.airport.updated_at) || 0;
    for (const row of [...config.terminals, ...config.servicePoints, ...config.feeRules]) {
      const ms = Date.parse(row.updated_at);
      if (Number.isFinite(ms) && ms > maxMs) maxMs = ms;
    }

    return NextResponse.json(
      {
        airport: {
          id: config.airport.id,
          iata_code: config.airport.iata_code,
          display_name: config.airport.display_name,
          municipality: config.airport.municipality,
          state_code: config.airport.state_code,
          coverage_status: config.airport.coverage_status,
        },
        flow: flowFor(config),
        terminals: config.terminals.map((t) => ({
          id: t.id,
          code: t.code,
          name: t.name,
          display_order: t.display_order,
          verified: t.verified,
        })),
        popular_airlines: airlines,
        general_dropoff: generalDropoff ? pointSummary(generalDropoff.servicePoint) : null,
        rideshare_pickup: ridesharePickup
          ? {
              point: pointSummary(ridesharePickup.servicePoint),
              instructions: pickupInstructions.map((i) => ({
                title: i.title,
                body: i.body,
                ...(i.image_url ? { image_url: i.image_url } : {}),
              })),
            }
          : null,
        fee,
        config_version: new Date(maxMs).toISOString(),
      },
      { headers: { 'Cache-Control': 'private, max-age=300' } },
    );
  } catch (err) {
    console.error('GET /api/airports/[id]/config failed:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
