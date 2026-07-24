import { useEffect, useState } from 'react';
import type { LatLng } from 'react-native-maps';
import { proximityGate, type ProximityGate } from '@/lib/route-eta';
import type { LocationFix } from '@/providers/driver-status';

/**
 * Continuously evaluated proximity gate for Arrived/Complete buttons.
 * Re-checks every few seconds so a gate blocked on staleness re-opens when a
 * fresh fix lands (and closes when the fix ages out) — and keeps the impure
 * clock read out of render.
 */
export function useProximityGate(
  fix: LocationFix | null,
  target: LatLng | null,
  radiusM: number,
): ProximityGate | null {
  const [gate, setGate] = useState<ProximityGate | null>(null);

  const targetLat = target?.latitude ?? null;
  const targetLng = target?.longitude ?? null;
  const targetKey = targetLat != null && targetLng != null ? `${targetLat},${targetLng}` : null;

  // Target changed → the previous gate is meaningless. Render-time state
  // adjustment is React's sanctioned reset pattern (no setState-in-effect).
  const [prevTargetKey, setPrevTargetKey] = useState(targetKey);
  if (prevTargetKey !== targetKey) {
    setPrevTargetKey(targetKey);
    setGate(null);
  }

  useEffect(() => {
    if (targetLat == null || targetLng == null) return;
    const compute = () =>
      setGate(
        proximityGate({
          fix,
          target: { latitude: targetLat, longitude: targetLng },
          radiusM,
          now: Date.now(),
        }),
      );
    // First evaluation lands a tick later — never a synchronous effect
    // setState — and then refreshes on an interval.
    const kick = setTimeout(compute, 0);
    const timer = setInterval(compute, 3_000);
    return () => {
      clearTimeout(kick);
      clearInterval(timer);
    };
  }, [fix, targetLat, targetLng, radiusM]);

  return targetKey == null ? null : gate;
}
