import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createApiClient } from '@/lib/supabase/api';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimit } from '@/lib/rate-limit';

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/driver/preferences — the driver's own participation state.
// PUT /api/driver/preferences — toggle pet opt-in / record Women Preferred
//                               enrollment consent.
//
// The underlying columns are service-role only (046 column grants): this
// route is the ONLY way a driver reads or writes them, and it returns a safe
// projection — never the raw row.
//
// Women Preferred is invitation-gated: enrollment is accepted ONLY while
// women_preferred_invited is true server-side. Clients can never self-invite;
// invitations are set exclusively by the admin API (audit-logged).
// ═══════════════════════════════════════════════════════════════════════════

const putSchema = z
  .object({
    petFriendlyOptIn: z.boolean().optional(),
    // true → enroll (requires a standing invitation); false → withdraw consent.
    womenPreferredEnroll: z.boolean().optional(),
  })
  .strict()
  .refine(
    (b) => b.petFriendlyOptIn !== undefined || b.womenPreferredEnroll !== undefined,
    { message: 'Nothing to update' },
  );

async function resolveDriver(request: NextRequest) {
  const { user } = await createApiClient(request);
  if (!user) return { user: null, driver: null };

  const svc = createServiceClient();
  const { data: driver } = await svc
    .from('drivers')
    .select('id, pet_friendly_opt_in, women_preferred_invited, women_preferred_enrolled')
    .eq('auth_user_id', user.id)
    .single();

  return { user, driver };
}

function projection(driver: {
  pet_friendly_opt_in: boolean;
  women_preferred_invited: boolean;
  women_preferred_enrolled: boolean;
}) {
  return {
    petFriendlyOptIn: Boolean(driver.pet_friendly_opt_in),
    womenPreferred: {
      invited: Boolean(driver.women_preferred_invited),
      enrolled: Boolean(driver.women_preferred_enrolled),
    },
  };
}

export async function GET(request: NextRequest) {
  try {
    const { user, driver } = await resolveDriver(request);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!driver) return NextResponse.json({ error: 'Not a driver' }, { status: 404 });

    return NextResponse.json(projection(driver));
  } catch (err) {
    console.error('GET /api/driver/preferences failed:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const rateLimited = await rateLimit(request, 'default');
    if (rateLimited) return rateLimited;

    const { user, driver } = await resolveDriver(request);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!driver) return NextResponse.json({ error: 'Not a driver' }, { status: 404 });

    let body: z.infer<typeof putSchema>;
    try {
      body = putSchema.parse(await request.json());
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const update: Record<string, unknown> = {};

    if (body.petFriendlyOptIn !== undefined) {
      update.pet_friendly_opt_in = body.petFriendlyOptIn;
    }

    if (body.womenPreferredEnroll !== undefined) {
      if (body.womenPreferredEnroll) {
        // Enrollment consent — valid only while invited. The invitation flag
        // itself is admin-only; a 403 here is final from the client's side.
        if (!driver.women_preferred_invited) {
          return NextResponse.json(
            { error: 'Enrollment is by invitation.' },
            { status: 403 },
          );
        }
        update.women_preferred_enrolled = true;
        update.women_preferred_enrolled_at = new Date().toISOString(); // consent timestamp
      } else {
        update.women_preferred_enrolled = false;
        update.women_preferred_enrolled_at = null;
      }
    }

    const svc = createServiceClient();
    const { data: updated, error } = await svc
      .from('drivers')
      .update(update)
      .eq('id', driver.id)
      .select('pet_friendly_opt_in, women_preferred_invited, women_preferred_enrolled')
      .single();

    if (error || !updated) {
      console.error('PUT /api/driver/preferences update failed:', error?.message);
      return NextResponse.json({ error: 'Update failed' }, { status: 500 });
    }

    return NextResponse.json(projection(updated));
  } catch (err) {
    console.error('PUT /api/driver/preferences failed:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
