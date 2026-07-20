import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ApiClient, ApiError, API } from '@takeme/shared';
import { getClerkToken } from '@/lib/clerk';
import { base64ToUint8Array } from '@/lib/base64';
import { useSupabase } from './supabase';
import { useAuth } from './auth';
import type {
  ApplicationUpdate,
  ApplicationUpdateResponse,
  BackgroundCheckStartResponse,
  LegalConsentInput,
  LegalDocumentContent,
  OnboardingMarket,
  OnboardingResponse,
  OnboardingState,
  TrainingAnswer,
  TrainingSubmitResponse,
  VehicleCheckResult,
  VehicleSubmission,
  VehicleSubmitResponse,
  WaitlistVehicleSize,
} from '@/types/onboarding';

export type UploadPhase = 'preparing' | 'uploading' | 'processing';

interface UploadDocumentInput {
  requirementKey: string;
  docType: string;
  base64: string;
  contentType: string;
  expiresOn?: string;
  onPhase?: (phase: UploadPhase) => void;
}

interface OnboardingContextValue {
  state: OnboardingState | null;
  markets: OnboardingMarket[];
  /** True only while the very first load is in flight. */
  loading: boolean;
  error: string | null;
  /** Set after a market change recomputed the requirements; index shows it once. */
  marketChangeNotice: string | null;
  dismissMarketChangeNotice: () => void;
  apiClient: ApiClient;
  refresh: () => Promise<void>;
  updateApplication: (body: ApplicationUpdate) => Promise<ApplicationUpdateResponse>;
  submitVehicle: (body: VehicleSubmission) => Promise<VehicleCheckResult>;
  fetchLegalDocuments: (keys: string[], locale?: string) => Promise<LegalDocumentContent[]>;
  acceptLegal: (
    consents: LegalConsentInput[],
    device: { platform: string; appVersion: string; osVersion: string; model: string },
  ) => Promise<void>;
  uploadDocument: (input: UploadDocumentInput) => Promise<void>;
  getDocumentUrl: (documentId: string) => Promise<string>;
  startBackgroundCheck: () => Promise<BackgroundCheckStartResponse>;
  submitTraining: (
    requirementKey: string,
    answers: TrainingAnswer[],
  ) => Promise<TrainingSubmitResponse['result']>;
  joinWaitlist: (input: {
    marketKey: string;
    vehicleSize: WaitlistVehicleSize;
    pickupArea?: string;
    notifyOptIn: boolean;
  }) => Promise<boolean>;
  leaveWaitlist: (marketKey: string) => Promise<void>;
}

const OnboardingContext = createContext<OnboardingContextValue | null>(null);

function messageFromError(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as { error?: string; message?: string } | null;
    return body?.error ?? body?.message ?? 'Something went wrong. Please try again.';
  }
  return err instanceof Error && err.message
    ? err.message
    : 'Something went wrong. Please try again.';
}

export function OnboardingProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const supabase = useSupabase();

  const [state, setState] = useState<OnboardingState | null>(null);
  const [markets, setMarkets] = useState<OnboardingMarket[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [marketChangeNotice, setMarketChangeNotice] = useState<string | null>(null);

  const apiClient = useMemo(
    () =>
      new ApiClient({
        baseUrl: process.env.EXPO_PUBLIC_API_BASE_URL!,
        getAccessToken: getClerkToken,
      }),
    [],
  );

  // Single-flight refresh: concurrent callers share one request.
  const refreshPromise = useRef<Promise<void> | null>(null);
  // Double-tap guard for mutations: one in-flight mutation per key.
  const inFlight = useRef<Map<string, Promise<unknown>>>(new Map());
  const hasLoaded = useRef(false);

  const refresh = useCallback((): Promise<void> => {
    if (refreshPromise.current) return refreshPromise.current;
    const run = (async () => {
      if (!hasLoaded.current) setLoading(true);
      try {
        const data = await apiClient.get<OnboardingResponse>(API.DRIVER_ONBOARDING);
        setState(data.state);
        setMarkets(data.markets);
        setError(null);
        hasLoaded.current = true;
      } catch (err) {
        // Tolerant by design: the dashboard mounts this provider globally and
        // must keep working offline. Screens surface `error` with a Retry.
        setError(messageFromError(err));
      } finally {
        setLoading(false);
        refreshPromise.current = null;
      }
    })();
    refreshPromise.current = run;
    return run;
  }, [apiClient]);

  useEffect(() => {
    if (!user) {
      hasLoaded.current = false;
      setState(null);
      setMarkets([]);
      setError(null);
      return;
    }
    void refresh();
  }, [user, refresh]);

  /**
   * Runs a mutation with a double-tap guard: while a call for `key` is in
   * flight, subsequent calls return the same promise instead of firing again.
   */
  const guarded = useCallback(<T,>(key: string, run: () => Promise<T>): Promise<T> => {
    const pending = inFlight.current.get(key);
    if (pending) return pending as Promise<T>;
    const promise = run().finally(() => {
      inFlight.current.delete(key);
    });
    inFlight.current.set(key, promise);
    return promise;
  }, []);

  const adoptState = useCallback((next: OnboardingState) => {
    setState(next);
    setError(null);
  }, []);

  const updateApplication = useCallback(
    (body: ApplicationUpdate) =>
      guarded('application', async () => {
        const res = await apiClient.post<ApplicationUpdateResponse>(
          API.DRIVER_ONBOARDING,
          body,
        );
        adoptState(res.state);
        if (res.marketChanged && res.state.market) {
          setMarketChangeNotice(res.state.market.displayName);
        }
        return res;
      }),
    [apiClient, guarded, adoptState],
  );

  const submitVehicle = useCallback(
    (body: VehicleSubmission) =>
      guarded('vehicle', async () => {
        const res = await apiClient.post<VehicleSubmitResponse>(
          API.DRIVER_ONBOARDING_VEHICLE,
          body,
        );
        adoptState(res.state);
        return res.vehicle;
      }),
    [apiClient, guarded, adoptState],
  );

  const fetchLegalDocuments = useCallback(
    async (keys: string[], locale = 'en') => {
      const res = await apiClient.get<{ documents: LegalDocumentContent[] }>(
        API.DRIVER_ONBOARDING_LEGAL,
        { keys: keys.join(','), locale },
      );
      return res.documents;
    },
    [apiClient],
  );

  const acceptLegal = useCallback(
    (
      consents: LegalConsentInput[],
      device: { platform: string; appVersion: string; osVersion: string; model: string },
    ) =>
      guarded('legal', async () => {
        const res = await apiClient.post<{ state: OnboardingState }>(
          API.DRIVER_ONBOARDING_LEGAL,
          { consents, clientAcceptedAt: new Date().toISOString(), device },
        );
        adoptState(res.state);
      }),
    [apiClient, guarded, adoptState],
  );

  const uploadDocument = useCallback(
    ({ requirementKey, docType, base64, contentType, expiresOn, onPhase }: UploadDocumentInput) =>
      guarded(`upload:${requirementKey}:${docType}`, async () => {
        onPhase?.('preparing');
        const bytes = base64ToUint8Array(base64);
        // A fresh signed upload slot every attempt keeps retries idempotent.
        const slot = await apiClient.post<{ path: string; token: string }>(
          API.DRIVER_ONBOARDING_DOCUMENTS,
          {
            action: 'create_upload',
            requirementKey,
            docType,
            contentType,
            sizeBytes: bytes.byteLength,
          },
        );
        onPhase?.('uploading');
        const { error: uploadError } = await supabase.storage
          .from('driver-docs')
          .uploadToSignedUrl(slot.path, slot.token, bytes.buffer as ArrayBuffer, { contentType });
        if (uploadError) {
          throw new Error('The upload did not go through. Check your connection and try again.');
        }
        onPhase?.('processing');
        const res = await apiClient.post<{ state: OnboardingState; documentId: string }>(
          API.DRIVER_ONBOARDING_DOCUMENTS,
          {
            action: 'submit',
            requirementKey,
            docType,
            path: slot.path,
            ...(expiresOn ? { expiresOn } : {}),
          },
        );
        adoptState(res.state);
      }),
    [apiClient, supabase, guarded, adoptState],
  );

  const getDocumentUrl = useCallback(
    async (documentId: string) => {
      const res = await apiClient.get<{ url: string }>(
        `${API.DRIVER_ONBOARDING_DOCUMENTS}/${documentId}`,
      );
      return res.url;
    },
    [apiClient],
  );

  const startBackgroundCheck = useCallback(
    () =>
      guarded('background', async () => {
        const res = await apiClient.post<BackgroundCheckStartResponse>(
          API.DRIVER_ONBOARDING_BACKGROUND,
          {},
        );
        adoptState(res.state);
        return res;
      }),
    [apiClient, guarded, adoptState],
  );

  const submitTraining = useCallback(
    (requirementKey: string, answers: TrainingAnswer[]) =>
      guarded(`training:${requirementKey}`, async () => {
        const res = await apiClient.post<TrainingSubmitResponse>(
          API.DRIVER_ONBOARDING_TRAINING,
          { requirementKey, answers },
        );
        adoptState(res.state);
        return res.result;
      }),
    [apiClient, guarded, adoptState],
  );

  const joinWaitlist = useCallback(
    (input: {
      marketKey: string;
      vehicleSize: WaitlistVehicleSize;
      pickupArea?: string;
      notifyOptIn: boolean;
    }) =>
      guarded('waitlist', async () => {
        const res = await apiClient.post<{ joined: boolean }>(
          API.DRIVER_ONBOARDING_WAITLIST,
          input,
        );
        return res.joined;
      }),
    [apiClient, guarded],
  );

  const leaveWaitlist = useCallback(
    (marketKey: string) =>
      guarded('waitlist', async () => {
        await apiClient.delete(
          `${API.DRIVER_ONBOARDING_WAITLIST}?marketKey=${encodeURIComponent(marketKey)}`,
        );
      }),
    [apiClient, guarded],
  );

  const dismissMarketChangeNotice = useCallback(() => setMarketChangeNotice(null), []);

  const value = useMemo<OnboardingContextValue>(
    () => ({
      state,
      markets,
      loading,
      error,
      marketChangeNotice,
      dismissMarketChangeNotice,
      apiClient,
      refresh,
      updateApplication,
      submitVehicle,
      fetchLegalDocuments,
      acceptLegal,
      uploadDocument,
      getDocumentUrl,
      startBackgroundCheck,
      submitTraining,
      joinWaitlist,
      leaveWaitlist,
    }),
    [
      state,
      markets,
      loading,
      error,
      marketChangeNotice,
      dismissMarketChangeNotice,
      apiClient,
      refresh,
      updateApplication,
      submitVehicle,
      fetchLegalDocuments,
      acceptLegal,
      uploadDocument,
      getDocumentUrl,
      startBackgroundCheck,
      submitTraining,
      joinWaitlist,
      leaveWaitlist,
    ],
  );

  return <OnboardingContext.Provider value={value}>{children}</OnboardingContext.Provider>;
}

export function useOnboarding(): OnboardingContextValue {
  const ctx = useContext(OnboardingContext);
  if (!ctx) {
    throw new Error('useOnboarding must be used within an OnboardingProvider');
  }
  return ctx;
}

export { messageFromError as onboardingErrorMessage };
