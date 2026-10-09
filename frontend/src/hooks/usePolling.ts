import { useCallback, useEffect, useRef, useState, type DependencyList } from "react";
import { isAbortError } from "../api/http";

export interface Polled<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  lastUpdated: Date | null;
  refresh: () => Promise<void>;
}

/**
 * Loads now, then every `intervalMs` while the tab is visible. Keeps showing
 * the last good data if a refresh fails, and exposes when it was fetched.
 */
export function usePolling<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  options: { intervalMs: number; enabled?: boolean; deps?: DependencyList },
): Polled<T> {
  const { intervalMs, enabled = true, deps = [] } = options;
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const controllerRef = useRef<AbortController | null>(null);
  const [state, setState] = useState<Omit<Polled<T>, "refresh">>({
    data: null,
    error: null,
    loading: true,
    lastUpdated: null,
  });

  const refresh = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await loaderRef.current(controller.signal);
      if (controller.signal.aborted) return;
      setState({ data, error: null, loading: false, lastUpdated: new Date() });
    } catch (e) {
      if (controller.signal.aborted || isAbortError(e)) return;
      setState((s) => ({ ...s, error: e, loading: false }));
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => controllerRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, ...deps]);

  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, intervalMs);
    return () => clearInterval(id);
  }, [enabled, intervalMs, refresh]);

  return { ...state, refresh };
}
