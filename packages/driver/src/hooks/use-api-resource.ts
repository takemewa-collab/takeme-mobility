import { useCallback, useEffect, useRef, useState } from 'react';

export type ResourcePhase = 'loading' | 'error' | 'ready';

export interface ApiResource<T> {
  /** 'loading' only while nothing has ever loaded; once data exists we stay 'ready'. */
  phase: ResourcePhase;
  data: T | null;
  /** True during any in-flight load (including background reloads). */
  fetching: boolean;
  /** True only for pull-to-refresh, so the spinner doesn't double up. */
  refreshing: boolean;
  reload: () => void;
  refresh: () => void;
}

/**
 * Minimal resource loader shared by the driver hub screens: initial load with
 * skeleton, error-with-retry when nothing ever loaded, silent background
 * reloads that keep showing the last good data, and pull-to-refresh. Pass
 * null while the API client isn't ready — the hook stays in 'loading'.
 *
 * The fetcher's IDENTITY is the reload trigger: memoize it with useCallback
 * and include query inputs (anchor, filter) in its deps.
 */
export function useApiResource<T>(fetcher: (() => Promise<T>) | null): ApiResource<T> {
  const [state, setState] = useState<{ phase: ResourcePhase; data: T | null }>({
    phase: 'loading',
    data: null,
  });
  const [fetching, setFetching] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const runIdRef = useRef(0);

  const run = useCallback(async (mode: 'load' | 'refresh') => {
    const fn = fetcherRef.current;
    if (!fn) return;
    const id = ++runIdRef.current;
    if (mode === 'refresh') setRefreshing(true);
    setFetching(true);
    try {
      const data = await fn();
      if (runIdRef.current === id) setState({ phase: 'ready', data });
    } catch {
      if (runIdRef.current === id) {
        // Keep showing the last good payload on a background failure; only a
        // never-loaded screen falls to the error state.
        setState((prev) => (prev.data != null ? prev : { phase: 'error', data: null }));
      }
    } finally {
      if (runIdRef.current === id) {
        setFetching(false);
        setRefreshing(false);
      }
    }
  }, []);

  // Initial load + reload whenever the fetcher identity changes (new query
  // inputs) or the API client becomes available.
  const hasFetcher = fetcher != null;
  useEffect(() => {
    if (hasFetcher) void run('load');
  }, [hasFetcher, fetcher, run]);

  const reload = useCallback(() => {
    setState((prev) => (prev.data != null ? prev : { phase: 'loading', data: null }));
    void run('load');
  }, [run]);

  const refresh = useCallback(() => {
    void run('refresh');
  }, [run]);

  return { phase: state.phase, data: state.data, fetching, refreshing, reload, refresh };
}
