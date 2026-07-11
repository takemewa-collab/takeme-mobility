import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { calculateRoute, geocodeAddress } from '@/lib/route-service';
import { generateQuotes, type QuoteResult } from '@/lib/pricing';
import { createApiClient } from '@/lib/supabase/api';
import { getSurgeMultiplier } from '@/lib/surge';
import { rateLimit } from '@/lib/rate-limit';

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/quotes
//
// Accepts pickup/dropoff as coordinates or addresses.
// Returns fare quotes for all vehicle tiers.
// Optionally persists to ride_quotes table if user is authenticated.
// ═══════════════════════════════════════════════════════════════════════════

// ── Request schema ───────────────────────────────────────────────────────

const coordsSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

const locationInputSchema = z.union([
  // Option A: coordinates
  z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    address: z.string().optional(),
  }),
  // Option B: address string only
  z.object({
    address: z.string().min(2),
  }),
]);

const requestSchema = z.object({
  pickup: locationInputSchema,
  dropoff: locationInputSchema,
  currency: z.string().length(3).default('USD'),
  surgeMultiplier: z.number().min(1).max(5).default(1.0),
  persist: z.boolean().default(false),   // save to ride_quotes table
});

type RequestBody = z.infer<typeof requestSchema>;

// ── Response shape ───────────────────────────────────────────────────────

interface QuoteResponse {
  route: {
    pickupAddress: string;
    pickupLat: number;
    pickupLng: number;
    dropoffAddress: string;
    dropoffLat: number;
    dropoffLng: number;
    distanceKm: number;
    durationMin: number;
    polyline: string;
  };
  quotes: QuoteResult[];
  savedQuoteIds: string[] | null;  // populated if persist=true
  expiresAt: string;               // ISO timestamp
}

// ── Helpers ──────────────────────────────────────────────────────────────

async function resolveLocation(input: z.infer<typeof locationInputSchema>): Promise<{
  lat: number;
  lng: number;
  address: string;
}> {
  if ('lat' in input && typeof input.lat === 'number') {
    // Coordinates provided — reverse geocode for address if missing
    if (input.address) {
      return { lat: input.lat, lng: input.lng, address: input.address };
    }
    // Could reverse-geocode here, but for now use coordinate string
    return { lat: input.lat, lng: input.lng, address: `${input.lat.toFixed(5)}, ${input.lng.toFixed(5)}` };
  }

  // Address only — geocode to coordinates
  if ('address' in input && input.address) {
    const geo = await geocodeAddress(input.address);
    return { lat: geo.lat, lng: geo.lng, address: geo.formattedAddress };
  }

  throw new Error('Location must include lat/lng or address');
}

const QUOTE_TTL_MINUTES = 5;

// ── Handler ──────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    // 0. Rate limit
    const rateLimited = await rateLimit(request, 'quotes');
    if (rateLimited) return rateLimited;

    // 1. Parse + validate
    let body: RequestBody;
    try {
      const raw = await request.json();
      body = requestSchema.parse(raw);
    } catch (err) {
      const message = err instanceof z.ZodError
        ? err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
        : 'Invalid request body';
      return NextResponse.json({ error: message }, { status: 400 });
    }

    // 2. Resolve locations (geocode if needed)
    const [pickup, dropoff] = await Promise.all([
      resolveLocation(body.pickup),
      resolveLocation(body.dropoff),
    ]);

    // 3. Calculate route via Google Directions
    const route = await calculateRoute({
      pickupLat: pickup.lat,
      pickupLng: pickup.lng,
      dropoffLat: dropoff.lat,
      dropoffLng: dropoff.lng,
    });

    // Use Google's resolved addresses if we geocoded from coords
    const pickupAddress = route.pickupAddress || pickup.address;
    const dropoffAddress = route.dropoffAddress || dropoff.address;

    // 4. Calculate dynamic surge multiplier if not explicitly provided
    let surgeMultiplier = body.surgeMultiplier;
    if (surgeMultiplier === 1.0) {
      try {
        surgeMultiplier = await getSurgeMultiplier(pickup.lat, pickup.lng);
      } catch { /* fallback to 1.0 */ }
    }

    // 5. Generate fare quotes for all tiers
    const quotes = generateQuotes(route.distanceKm, route.durationMin, {
      surgeMultiplier,
      currency: body.currency,
    });

    const expiresAt = new Date(Date.now() + QUOTE_TTL_MINUTES * 60 * 1000).toISOString();

    // 5. Persist to ride_quotes if requested and user is authenticated
    let savedQuoteIds: string[] | null = null;

    if (body.persist) {
      try {
        const { supabase, user } = await createApiClient(request);

        if (user) {
          const rows = quotes.map(q => ({
            rider_id: user.id,
            pickup_address: pickupAddress,
            pickup_lat: pickup.lat,
            pickup_lng: pickup.lng,
            dropoff_address: dropoffAddress,
            dropoff_lat: dropoff.lat,
            dropoff_lng: dropoff.lng,
            distance_km: route.distanceKm,
            duration_min: route.durationMin,
            route_polyline: route.polyline,
            vehicle_class: q.vehicleClass,
            base_fare: q.fare.baseFare,
            distance_fare: q.fare.distanceFare,
            time_fare: q.fare.timeFare,
            surge_multiplier: q.fare.surgeMultiplier,
            total_fare: q.fare.total,
            currency: q.fare.currency,
            expires_at: expiresAt,
          }));

          const { data, error } = await supabase
            .from('ride_quotes')
            .insert(rows)
            .select('id');

          if (!error && data) {
            savedQuoteIds = data.map((r: { id: string }) => r.id);
          }
        }
      } catch (dbErr) {
        // Non-fatal — quotes still work without persistence
        console.warn('Failed to persist quotes:', dbErr);
      }
    }

    // 6. Return response
    const response: QuoteResponse = {
      route: {
        pickupAddress,
        pickupLat: pickup.lat,
        pickupLng: pickup.lng,
        dropoffAddress,
        dropoffLat: dropoff.lat,
        dropoffLng: dropoff.lng,
        distanceKm: route.distanceKm,
        durationMin: route.durationMin,
        polyline: route.polyline,
      },
      quotes,
      savedQuoteIds,
      expiresAt,
    };

    return NextResponse.json(response);
  } catch (err) {
    console.error('POST /api/quotes failed:', err);
    const message = err instanceof Error ? err.message : 'Failed to generate quotes';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
