import React, { useCallback, useMemo } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { API } from '@takeme/shared';
import { useTrip } from '@/providers/trip';
import { useApiResource } from '@/hooks/use-api-resource';
import type { IssueCategory, TripDetailResponse } from '@/types/driver-hub';
import { TripDetailScreenView } from '@/screens/trip-detail-screen';

/**
 * Trip detail container: the driver's receipt for one of their own trips
 * (route, timeline, fare + earnings breakdown) plus the issue-report flow.
 */
export default function TripDetailRoute() {
  const router = useRouter();
  const { apiClient } = useTrip();
  const { id } = useLocalSearchParams<{ id: string }>();

  const fetcher = useMemo(() => {
    if (!apiClient || !id) return null;
    return () => apiClient.get<TripDetailResponse>(`${API.DRIVER_TRIPS}/${id}`);
  }, [apiClient, id]);
  const detail = useApiResource(fetcher);

  const submitIssue = useCallback(
    async (category: IssueCategory, message: string): Promise<boolean> => {
      if (!apiClient || !id) return false;
      try {
        await apiClient.post(`${API.DRIVER_TRIPS}/${id}`, { category, message });
        return true;
      } catch {
        return false;
      }
    },
    [apiClient, id],
  );

  const goBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(app)/(tabs)/trips');
  }, [router]);

  return (
    <TripDetailScreenView
      phase={detail.phase}
      detail={detail.data}
      onRetry={detail.reload}
      onBack={goBack}
      onSubmitIssue={submitIssue}
    />
  );
}
