import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { API } from '@takeme/shared';
import { useTrip } from '@/providers/trip';
import type { TripRow, TripsResponse } from '@/types/driver-hub';
import { dayAnchors, mergeTripPages, tripRouteForStatus } from '@/lib/trips-view';
import { TripsScreenView, type TripsFilter } from '@/screens/trips-screen';

interface ListState {
  phase: 'loading' | 'error' | 'ready';
  trips: TripRow[];
  nextBefore: string | null;
}

/**
 * Trips tab container: keyset-paginated history with a segmented filter and
 * the in-flight trip pinned on top. The list re-syncs silently on focus so a
 * just-completed trip appears without a manual refresh.
 */
export default function TripsTab() {
  const router = useRouter();
  const { apiClient, activeTrip } = useTrip();

  const [filter, setFilter] = useState<TripsFilter>('all');
  const [list, setList] = useState<ListState>({ phase: 'loading', trips: [], nextBefore: null });
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const requestIdRef = useRef(0);

  // Day anchors are clock reads — kept in state (never read in render) and
  // refreshed on focus so a session crossing midnight re-labels "Today".
  const [anchors, setAnchors] = useState(() => dayAnchors(new Date()));

  const loadFirstPage = useCallback(
    async (mode: 'initial' | 'refresh' | 'silent') => {
      if (!apiClient) return;
      const id = ++requestIdRef.current;
      if (mode === 'refresh') setRefreshing(true);
      try {
        const res = await apiClient.get<TripsResponse>(API.DRIVER_TRIPS, {
          filter,
          limit: '25',
        });
        if (requestIdRef.current !== id) return;
        setList({ phase: 'ready', trips: res.trips, nextBefore: res.nextBefore });
      } catch {
        if (requestIdRef.current !== id) return;
        // A silent/refresh failure keeps the last good list on screen.
        setList((prev) =>
          prev.trips.length > 0 && mode !== 'initial'
            ? prev
            : { phase: 'error', trips: [], nextBefore: null },
        );
      } finally {
        if (requestIdRef.current === id) setRefreshing(false);
      }
    },
    [apiClient, filter],
  );

  // Initial load + reload when the filter changes.
  useEffect(() => {
    setList({ phase: 'loading', trips: [], nextBefore: null });
    void loadFirstPage('initial');
  }, [loadFirstPage]);

  // Silent re-sync on focus (skip the mount focus — the effect above ran).
  const firstFocusRef = useRef(true);
  useFocusEffect(
    useCallback(() => {
      setAnchors(dayAnchors(new Date()));
      if (firstFocusRef.current) {
        firstFocusRef.current = false;
        return;
      }
      void loadFirstPage('silent');
    }, [loadFirstPage]),
  );

  const loadMore = useCallback(async () => {
    if (!apiClient || loadingMore || list.phase !== 'ready' || !list.nextBefore) return;
    setLoadingMore(true);
    const id = requestIdRef.current;
    try {
      const res = await apiClient.get<TripsResponse>(API.DRIVER_TRIPS, {
        filter,
        limit: '25',
        before: list.nextBefore,
      });
      if (requestIdRef.current !== id) return;
      setList((prev) => ({
        ...prev,
        trips: mergeTripPages(prev.trips, res.trips),
        nextBefore: res.nextBefore,
      }));
    } catch {
      // Next scroll attempt retries; the footer spinner simply stops.
    } finally {
      setLoadingMore(false);
    }
  }, [apiClient, filter, loadingMore, list.phase, list.nextBefore]);

  const continueTrip = useCallback(() => {
    if (!activeTrip) return;
    const route = tripRouteForStatus(activeTrip.status);
    if (route) router.push(route as never);
  }, [activeTrip, router]);

  return (
    <TripsScreenView
      phase={list.phase}
      trips={list.trips}
      filter={filter}
      onFilterChange={setFilter}
      loadingMore={loadingMore}
      onEndReached={() => void loadMore()}
      refreshing={refreshing}
      onRefresh={() => void loadFirstPage('refresh')}
      onRetry={() => {
        setList({ phase: 'loading', trips: [], nextBefore: null });
        void loadFirstPage('initial');
      }}
      activeTrip={
        activeTrip
          ? {
              id: activeTrip.id,
              status: activeTrip.status,
              pickupAddress: activeTrip.pickup_address ?? null,
              dropoffAddress: activeTrip.dropoff_address ?? null,
            }
          : null
      }
      onContinueTrip={continueTrip}
      onTripPress={(id) => router.push(`/(app)/trips/${id}` as never)}
      todayYmd={anchors.todayYmd}
      yesterdayYmd={anchors.yesterdayYmd}
    />
  );
}
