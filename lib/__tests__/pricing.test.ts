import { describe, expect, it } from 'vitest';
import { TIERS, calculateFare, stopFeePerStop } from '../pricing';

const round2 = (n: number) => Math.round(n * 100) / 100;

describe('multi-stop fare', () => {
  const tier = TIERS.economy;
  const km = 10;
  const min = 20;

  it('adds no stop fee for a direct trip', () => {
    const fare = calculateFare(tier, km, min);
    expect(fare.stopFee).toBe(0);
  });

  it('charges the configured flat fee per intermediate stop', () => {
    const direct = calculateFare(tier, km, min);
    const withStops = calculateFare(tier, km, min, { stopCount: 2 });
    expect(withStops.stopFee).toBe(round2(2 * stopFeePerStop()));
    expect(withStops.total).toBe(round2(direct.total + 2 * stopFeePerStop()));
  });

  it('does not surge the stop fee', () => {
    const surged = calculateFare(tier, km, min, { stopCount: 3, surgeMultiplier: 2.0 });
    const rideCost = (tier.baseFare + round2(km * tier.perKmRate) + round2(min * tier.perMinRate)) * 2.0;
    const expected = round2(rideCost + tier.bookingFee + round2(3 * stopFeePerStop()));
    expect(surged.total).toBe(round2(Math.max(expected, tier.minFare)));
    expect(surged.stopFee).toBe(round2(3 * stopFeePerStop()));
  });

  it('keeps the minimum-fare floor with stops included', () => {
    // Tiny trip: subtotal under the floor even with a stop fee.
    const fare = calculateFare(tier, 0.3, 1, { stopCount: 1 });
    expect(fare.total).toBeGreaterThanOrEqual(tier.minFare);
    expect(fare.minFareApplied).toBe(fare.total === tier.minFare);
  });

  it('single-destination fares are unchanged by the stopCount option default', () => {
    const a = calculateFare(tier, km, min);
    const b = calculateFare(tier, km, min, { stopCount: 0 });
    expect(a.total).toBe(b.total);
  });
});
