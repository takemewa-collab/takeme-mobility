import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createApiClient } from '@/lib/supabase/api';
import { findNearbyDrivers } from '@/lib/dispatch';
import { rateLimit } from '@/lib/rate-limit';

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/mobile/nearby — truthful pre-match availability.
//
// Returns ONLY an eligible-driver count near the rider. No positions, no
// names, no vehicles, no plates, no ETAs: before a match exists, a rider is
// entitled to know that service is (un)available — nothing more. The count
// comes from the same eligibility query dispatch uses (online + verified +
// active + fresh location), so it can never claim supply that could not
// actually be offered a ride.
// ═══════════════════════════════════════════════════════════════════════════

const schema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export async function POST(request: NextRequest) {
  try {
    const rateLimited = await rateLimit(request, 'mobile-nearby');
    if (rateLimited) return rateLimited;

    const { user } = await createApiClient(request);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = schema.parse(await request.json());

    // Count across all vehicle classes within the standard dispatch radius.
    const classes = ['economy', 'comfort', 'premium'] as const;
    const seen = new Set<string>();
    for (const vehicleClass of classes) {
      const drivers = await findNearbyDrivers(body.lat, body.lng, vehicleClass, 5000, 10);
      for (const d of drivers) seen.add(d.driver_id);
    }

    return NextResponse.json({ available: seen.size });
  } catch (err) {
    console.error('POST /api/mobile/nearby failed:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
