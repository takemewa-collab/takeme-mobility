// ═══════════════════════════════════════════════════════════════════════════
// Driver ride earnings — the wallet credit that settles a completed trip.
//
// Both settlement paths call creditRideEarning:
//   - PUT /api/driver/rides action:complete (common path, right after capture)
//   - Stripe webhook payment_intent.succeeded (Stripe-retried safety net)
// The credit_ride_earning RPC (migration 052) is idempotent per ride, so the
// two paths can never double-pay a driver.
// ═══════════════════════════════════════════════════════════════════════════
import { createServiceClient } from '@/lib/supabase/service';

const DEFAULT_RATE = 0.8;

/** Driver's share of the captured fare. Env-tunable, defaults to 80%. */
export function driverEarningsRate(): number {
  const raw = Number(process.env.DRIVER_EARNINGS_RATE ?? DEFAULT_RATE);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : DEFAULT_RATE;
}

export function driverShare(fareAmount: number): number {
  return Math.round(fareAmount * driverEarningsRate() * 100) / 100;
}

/**
 * Idempotently credit the assigned driver's wallet for a captured ride
 * payment. Returns true when this call performed the credit, false when the
 * ride was already credited (or has no assigned driver).
 */
export async function creditRideEarning(params: {
  rideId: string;
  fareAmount: number;
}): Promise<boolean> {
  const svc = createServiceClient();

  const { data: ride } = await svc
    .from('rides')
    .select('assigned_driver_id')
    .eq('id', params.rideId)
    .maybeSingle();
  if (!ride?.assigned_driver_id) return false;

  // Wallets are keyed by the auth user id (011/050), not the drivers row id.
  const { data: driver } = await svc
    .from('drivers')
    .select('auth_user_id')
    .eq('id', ride.assigned_driver_id)
    .maybeSingle();
  if (!driver?.auth_user_id) return false;

  const amount = driverShare(params.fareAmount);
  const { data, error } = await svc.rpc('credit_ride_earning', {
    p_driver_user_id: driver.auth_user_id,
    p_ride_id: params.rideId,
    p_amount: amount,
    p_description: `Ride earning — ${Math.round(driverEarningsRate() * 100)}% of $${params.fareAmount.toFixed(2)}`,
  });
  if (error) {
    console.error(`[earnings] credit failed for ride ${params.rideId}:`, error.message);
    return false;
  }
  if (data === true) {
    console.log(`[earnings] credited $${amount.toFixed(2)} for ride ${params.rideId}`);
  }
  return data === true;
}
