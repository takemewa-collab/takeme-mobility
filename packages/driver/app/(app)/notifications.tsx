import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import { API } from '@takeme/shared';
import { useTrip } from '@/providers/trip';
import type { DriverNotification, NotificationsResponse } from '@/types/driver-hub';
import { NotificationsScreenView } from '@/screens/notifications-screen';

interface ListState {
  phase: 'loading' | 'error' | 'ready';
  notifications: DriverNotification[];
  unreadCount: number;
  nextBefore: string | null;
}

/**
 * Notification center container. Rows are real backend events only; tapping
 * marks the row read (optimistically) and deep-links via its payload:
 * payoutId → Earnings, requirementKey → Activation Center, rideId → trip
 * detail.
 */
export default function NotificationsRoute() {
  const router = useRouter();
  const { apiClient } = useTrip();

  const [list, setList] = useState<ListState>({
    phase: 'loading',
    notifications: [],
    unreadCount: 0,
    nextBefore: null,
  });
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const requestIdRef = useRef(0);

  const loadFirstPage = useCallback(
    async (mode: 'initial' | 'refresh') => {
      if (!apiClient) return;
      const id = ++requestIdRef.current;
      if (mode === 'refresh') setRefreshing(true);
      try {
        const res = await apiClient.get<NotificationsResponse>(API.DRIVER_NOTIFICATIONS, {
          limit: '30',
        });
        if (requestIdRef.current !== id) return;
        setList({
          phase: 'ready',
          notifications: res.notifications,
          unreadCount: res.unreadCount,
          nextBefore: res.nextBefore,
        });
      } catch {
        if (requestIdRef.current !== id) return;
        setList((prev) =>
          prev.notifications.length > 0 && mode === 'refresh'
            ? prev
            : { phase: 'error', notifications: [], unreadCount: 0, nextBefore: null },
        );
      } finally {
        if (requestIdRef.current === id) setRefreshing(false);
      }
    },
    [apiClient],
  );

  useEffect(() => {
    void loadFirstPage('initial');
  }, [loadFirstPage]);

  const loadMore = useCallback(async () => {
    if (!apiClient || loadingMore || list.phase !== 'ready' || !list.nextBefore) return;
    setLoadingMore(true);
    const id = requestIdRef.current;
    try {
      const res = await apiClient.get<NotificationsResponse>(API.DRIVER_NOTIFICATIONS, {
        limit: '30',
        before: list.nextBefore,
      });
      if (requestIdRef.current !== id) return;
      setList((prev) => {
        const seen = new Set(prev.notifications.map((n) => n.id));
        return {
          ...prev,
          notifications: [
            ...prev.notifications,
            ...res.notifications.filter((n) => !seen.has(n.id)),
          ],
          nextBefore: res.nextBefore,
        };
      });
    } catch {
      // Next scroll retries.
    } finally {
      setLoadingMore(false);
    }
  }, [apiClient, loadingMore, list.phase, list.nextBefore]);

  const markAllRead = useCallback(() => {
    if (!apiClient) return;
    const now = new Date().toISOString();
    setList((prev) => ({
      ...prev,
      unreadCount: 0,
      notifications: prev.notifications.map((n) => (n.read_at ? n : { ...n, read_at: now })),
    }));
    apiClient.put(API.DRIVER_NOTIFICATIONS, { all: true }).catch(() => {
      // Server truth restores on next load if this failed.
    });
  }, [apiClient]);

  const pressItem = useCallback(
    (notification: DriverNotification) => {
      if (apiClient && notification.read_at == null) {
        const now = new Date().toISOString();
        setList((prev) => ({
          ...prev,
          unreadCount: Math.max(0, prev.unreadCount - 1),
          notifications: prev.notifications.map((n) =>
            n.id === notification.id ? { ...n, read_at: now } : n,
          ),
        }));
        apiClient.put(API.DRIVER_NOTIFICATIONS, { ids: [notification.id] }).catch(() => {});
      }
      const data = notification.data ?? {};
      if (typeof data.rideId === 'string' && data.rideId) {
        router.push(`/(app)/trips/${data.rideId}` as never);
      } else if (typeof data.payoutId === 'string' && data.payoutId) {
        router.push('/(app)/(tabs)/earnings');
      } else if (typeof data.requirementKey === 'string' && data.requirementKey) {
        router.push('/onboarding');
      }
    },
    [apiClient, router],
  );

  const goBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(app)/(tabs)/dashboard');
  }, [router]);

  return (
    <NotificationsScreenView
      phase={list.phase}
      notifications={list.notifications}
      unreadCount={list.unreadCount}
      loadingMore={loadingMore}
      onEndReached={() => void loadMore()}
      refreshing={refreshing}
      onRefresh={() => void loadFirstPage('refresh')}
      onRetry={() => {
        setList({ phase: 'loading', notifications: [], unreadCount: 0, nextBefore: null });
        void loadFirstPage('initial');
      }}
      onBack={goBack}
      onMarkAllRead={markAllRead}
      onPressItem={pressItem}
    />
  );
}
