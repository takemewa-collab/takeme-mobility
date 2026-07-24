import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { API, ApiError } from '@takeme/shared';
import { useTrip } from '@/providers/trip';
import { useApiResource } from '@/hooks/use-api-resource';
import type {
  EarningsResponse,
  IncentivesResponse,
  PayoutExecutionResult,
  PayoutsResponse,
} from '@/types/driver-hub';
import { EarningsScreenView } from '@/screens/earnings-screen';
import { CashOutSheet } from '@/screens/cash-out-sheet';
import { runPayoutSetup, type PayoutSetupOutcome } from '@/lib/payout-setup';

/**
 * Earnings tab container: wires the API to the presentational screen.
 * All aggregation happens server-side; this file only manages query inputs
 * (week anchor), the cash-out sheet, and refetch policy.
 */
export default function EarningsTab() {
  const router = useRouter();
  const { apiClient } = useTrip();

  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const earningsFetcher = useMemo(() => {
    if (!apiClient) return null;
    const params: Record<string, string> = { tz };
    if (anchor) params.anchor = anchor;
    return () => apiClient.get<EarningsResponse>(API.DRIVER_EARNINGS, params);
  }, [apiClient, tz, anchor]);
  const earnings = useApiResource(earningsFetcher);

  const payoutsFetcher = useMemo(() => {
    if (!apiClient) return null;
    return () => apiClient.get<PayoutsResponse>(API.DRIVER_PAYOUTS);
  }, [apiClient]);
  const payouts = useApiResource(payoutsFetcher);

  const incentivesFetcher = useMemo(() => {
    if (!apiClient) return null;
    return () => apiClient.get<IncentivesResponse>(API.DRIVER_INCENTIVES);
  }, [apiClient]);
  const incentives = useApiResource(incentivesFetcher);

  // Payout/connect state can change outside the app (Stripe onboarding in a
  // browser) — re-fetch whenever the tab regains focus. Skip the very first
  // focus: the mount fetch already covers it.
  const firstFocusRef = useRef(true);
  const reloadPayouts = payouts.reload;
  useFocusEffect(
    useCallback(() => {
      if (firstFocusRef.current) {
        firstFocusRef.current = false;
        return;
      }
      reloadPayouts();
      console.log('[payout-setup] status=refetched (tab focus)');
    }, [reloadPayouts]),
  );

  const handlePrevWeek = useCallback(() => {
    const prev = earnings.data?.nav.prevAnchor;
    if (prev) {
      setSelectedDay(null);
      setAnchor(prev);
    }
  }, [earnings.data]);

  const handleNextWeek = useCallback(() => {
    const next = earnings.data?.nav.nextAnchor;
    if (next) {
      setSelectedDay(null);
      setAnchor(next);
    }
  }, [earnings.data]);

  const handleRefresh = useCallback(() => {
    earnings.refresh();
    payouts.reload();
    incentives.reload();
  }, [earnings, payouts, incentives]);

  const handleRetry = useCallback(() => {
    earnings.reload();
    payouts.reload();
    incentives.reload();
  }, [earnings, payouts, incentives]);

  const submitPayout = useCallback(
    async (
      amountUsd: number,
      speed: 'instant' | 'standard',
      idempotencyKey: string,
    ): Promise<PayoutExecutionResult> => {
      if (!apiClient) throw new Error('API unavailable');
      try {
        return await apiClient.post<PayoutExecutionResult>(API.DRIVER_PAYOUTS, {
          amountUsd,
          speed,
          idempotencyKey,
        });
      } catch (err) {
        // 422 carries the full result shape (ok:false + failureReason) — that
        // is an ANSWER, not a transport failure.
        if (
          err instanceof ApiError &&
          err.status === 422 &&
          err.body != null &&
          typeof err.body === 'object' &&
          'ok' in (err.body as Record<string, unknown>)
        ) {
          return err.body as PayoutExecutionResult;
        }
        throw err;
      }
    },
    [apiClient],
  );

  const openAccountLink = useCallback(
    async (mode: 'onboard' | 'manage'): Promise<PayoutSetupOutcome> => {
      if (!apiClient) {
        return {
          ok: false,
          error: { code: 'network', message: "Couldn't reach TAKEME. Check your connection." },
        };
      }
      const outcome = await runPayoutSetup(apiClient, mode);
      // Whatever happened in the browser, the server is the truth now.
      payouts.reload();
      console.log('[payout-setup] status=refetched');
      return outcome;
    },
    [apiClient, payouts],
  );

  const handlePayoutCompleted = useCallback(() => {
    payouts.reload();
    earnings.reload();
  }, [payouts, earnings]);

  return (
    <>
      <EarningsScreenView
        phase={earnings.phase}
        earnings={earnings.data}
        payouts={payouts.data}
        incentives={incentives.data?.programs ?? []}
        weekFetching={earnings.fetching && earnings.data != null}
        refreshing={earnings.refreshing}
        onRefresh={handleRefresh}
        onRetry={handleRetry}
        onPrevWeek={handlePrevWeek}
        onNextWeek={handleNextWeek}
        selectedDay={selectedDay}
        onSelectDay={setSelectedDay}
        onOpenCashOut={() => setSheetOpen(true)}
        onViewDayTrips={() => router.push('/(app)/(tabs)/trips')}
      />
      <CashOutSheet
        visible={sheetOpen}
        onClose={() => setSheetOpen(false)}
        payouts={payouts.data}
        payoutsPhase={payouts.phase}
        onRetryPayouts={payouts.reload}
        onSubmit={submitPayout}
        onOpenAccountLink={openAccountLink}
        onCompleted={handlePayoutCompleted}
      />
    </>
  );
}
