import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createServiceClient } from '@/lib/supabase/service';
import { verifyInternalRequest } from '@/lib/auth/internal-auth';

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/driver/earnings/add
// Adds earnings to a driver's wallet. Called by the system after ride
// completion (not directly by drivers).
// ═══════════════════════════════════════════════════════════════════════════

const schema = z.object({
  driverId: z.string().uuid(),
  amount: z.number().positive().max(10000),
  type: z.enum(['ride_earning', 'tip', 'bonus']).default('ride_earning'),
  description: z.string().optional(),
  rideId: z.string().uuid().optional(),
});

export async function POST(request: NextRequest) {
  try {
    // Internal systems only (called server-side after ride completion).
    // Credits real money to a wallet, so it must never be reachable by clients.
    if (!verifyInternalRequest(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const body = schema.parse(await request.json());
    const svc = createServiceClient();

    const { error } = await svc.rpc('add_driver_earning', {
      p_driver_id: body.driverId,
      p_amount: body.amount,
      p_type: body.type,
      p_description: body.description ?? `${body.type}: $${body.amount.toFixed(2)}`,
      p_ride_id: body.rideId ?? null,
    });

    if (error) {
      console.error('[earnings/add] RPC failed:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ added: true, amount: body.amount }, { status: 201 });
  } catch (err) {
    console.error('[earnings/add]', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed' }, { status: 500 });
  }
}
