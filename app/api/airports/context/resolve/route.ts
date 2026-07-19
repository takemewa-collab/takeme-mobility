import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createApiClient } from '@/lib/supabase/api';
import { rateLimit } from '@/lib/rate-limit';
import {
  airportFeeDetail,
  flowFor,
  getAirportConfig,
  instructionsFor,
  resolveAirlineAccess,
  resolveGeneralFallback,
  type ResolvedAccess,
} from '@/lib/airports/resolution';

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/airports/context/resolve
//
// Rider picked an airport (and maybe an airline / flight) — resolve the
// exact terminal + service point to route to, with rider instructions and
// the fee. skip=true (or no airline) → the general fallback point.
//
// HARD RULE: we never return the airport centroid. No bookable active
// service point → 409, the client keeps the normal (non-airport) flow.
// ═══════════════════════════════════════════════════════════════════════════

const FLIGHT_NUMBER_RE = /^[A-Z0-9]{2,3}\s?[0-9]{1,4}[A-Z]?$/;

const requestSchema = z.object({
  airportId: z.string().uuid(),
  direction: z.enum(['airport_pickup', 'airport_dropoff']),
  airlineId: z.string().uuid().optional(),
  flightNumber: z
    .string()
    .trim()
    .toUpperCase()
    .regex(FLIGHT_NUMBER_RE, 'Invalid flight number')
    .optional(),
  skip: z.boolean().optional(),
});

const FLOW_UNAVAILABLE = 'Airport flow is not available here yet.';

export async function POST(request: NextRequest) {
  try {
    const rateLimited = await rateLimit(request, 'airports');
    if (rateLimited) return rateLimited;

    const { user } = await createApiClient(request);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    let body: z.infer<typeof requestSchema>;
    try {
      body = requestSchema.parse(await request.json());
    } catch (err) {
      const message = err instanceof z.ZodError
        ? err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
        : 'Invalid request body';
      return NextResponse.json({ error: message }, { status: 400 });
    }

    const config = await getAirportConfig(body.airportId);
    if (!config || !config.airport.active) {
      return NextResponse.json({ error: 'Airport not found' }, { status: 404 });
    }

    const flow = flowFor(config);
    if (!flow.enabled) {
      return NextResponse.json({ error: FLOW_UNAVAILABLE }, { status: 409 });
    }

    const useGeneral = body.skip === true || !body.airlineId;
    let access: ResolvedAccess | null = useGeneral
      ? await resolveGeneralFallback(body.airportId, body.direction)
      : await resolveAirlineAccess(body.airportId, body.airlineId!, body.direction);

    // An unknown/inactive airline degrades to the general point rather than
    // blocking the booking.
    if (!access && !useGeneral) {
      access = await resolveGeneralFallback(body.airportId, body.direction);
    }
    if (!access) {
      return NextResponse.json({ error: FLOW_UNAVAILABLE }, { status: 409 });
    }

    const point = access.servicePoint;
    const selectionMethod =
      access.selectionMethod === 'airline' && body.flightNumber ? 'flight' : access.selectionMethod;

    const [riderInstructions, fee] = await Promise.all([
      instructionsFor(body.airportId, point.id, body.direction, 'rider'),
      airportFeeDetail(body.airportId, body.direction),
    ]);

    const generalName =
      body.direction === 'airport_dropoff' ? 'General airport drop-off' : point.name;

    return NextResponse.json({
      ...(access.airline
        ? {
            airline: {
              id: access.airline.id,
              display_name: access.airline.display_name,
              iata_code: access.airline.iata_code,
            },
          }
        : {}),
      ...(access.terminal
        ? { terminal: { id: access.terminal.id, code: access.terminal.code, name: access.terminal.name } }
        : {}),
      service_point: {
        id: point.id,
        name: access.airline ? point.name : generalName,
        lat: point.lat,
        lng: point.lng,
        level: point.level,
        door: point.door,
        zone: point.zone,
        island: point.island,
        verified: point.verified,
      },
      selection_method: selectionMethod,
      instructions: {
        rider: riderInstructions.map((i) => ({
          title: i.title,
          body: i.body,
          ...(i.image_url ? { image_url: i.image_url } : {}),
        })),
      },
      fee,
      ...(point.verified ? {} : { unverified_notice: true }),
    });
  } catch (err) {
    console.error('POST /api/airports/context/resolve failed:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
