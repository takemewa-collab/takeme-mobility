import { useEffect, useRef, useState } from 'react';
import type { LatLng } from 'react-native-maps';
import { API } from '@takeme/shared';
import type { ApiClient } from '@takeme/shared';
import { decodePolyline, shouldRefreshRoute } from '@/lib/route-eta';

export interface LiveRoute {
  etaMin: number;
  distanceKm: number;
  coords: LatLng[];
  fetchedAtMs: number;
}

/**
 * Real driving route from the driver's live position to `target`, via
 * GET /api/driver/route (Google Directions server-side). Refreshes on the
 * ROUTE_REFRESH cadence or when the driver has moved materially; never
 * computes an ETA from a missing position — the hook simply reports null
 * until a route exists.
 */
export function useRouteEta(input: {
  apiClient: ApiClient | null;
  driver: LatLng | null;
  target: LatLng | null;
  enabled: boolean;
}): LiveRoute | null {
  const { apiClient, driver, target, enabled } = input;
  const [route, setRoute] = useState<LiveRoute | null>(null);
  const lastFetchRef = useRef<{ atMs: number; from: LatLng } | null>(null);
  const inFlightRef = useRef(false);

  // Reset when the target changes (pickup → destination handoff).
  const targetKey = target ? `${target.latitude.toFixed(5)},${target.longitude.toFixed(5)}` : null;
  const prevTargetKeyRef = useRef(targetKey);
  if (prevTargetKeyRef.current !== targetKey) {
    prevTargetKeyRef.current = targetKey;
    lastFetchRef.current = null;
  }

  useEffect(() => {
    if (!enabled || !apiClient || !driver || !target) return;

    let cancelled = false;
    const tick = async () => {
      if (cancelled || inFlightRef.current) return;
      const now = Date.now();
      if (
        !shouldRefreshRoute({
          lastFetchedAtMs: lastFetchRef.current?.atMs ?? null,
          lastFetchedFrom: lastFetchRef.current?.from ?? null,
          current: driver,
          now,
        })
      ) {
        return;
      }
      inFlightRef.current = true;
      try {
        const res = await apiClient.get<{
          distanceKm: number;
          durationMin: number;
          polyline: string;
        }>(
          `${API.DRIVER_ROUTE}?toLat=${target.latitude}&toLng=${target.longitude}&fromLat=${driver.latitude}&fromLng=${driver.longitude}`,
        );
        if (!cancelled && res) {
          lastFetchRef.current = { atMs: now, from: driver };
          setRoute({
            etaMin: Math.max(1, Math.round(res.durationMin)),
            distanceKm: res.distanceKm,
            coords: decodePolyline(res.polyline),
            fetchedAtMs: now,
          });
        }
      } catch {
        // Transient — the next tick retries; stale route stays visible.
      } finally {
        inFlightRef.current = false;
      }
    };

    void tick();
    const interval = setInterval(tick, 5_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [enabled, apiClient, driver, target]);

  return route;
}
