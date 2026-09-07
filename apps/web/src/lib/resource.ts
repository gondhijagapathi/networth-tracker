/**
 * Loading data from the API.
 *
 * A deliberately small hook rather than a data-fetching library. This application has a
 * handful of endpoints, no optimistic updates and no offline cache to reconcile, and the
 * three states a screen actually has — loading, failed, loaded — fit in twenty lines.
 *
 * The one thing it does carefully is cancellation: a user who taps through three assets
 * quickly must not have the first response overwrite the third.
 */

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from './api.js';

export interface Resource<T> {
  data: T | null;
  loading: boolean;
  error: ApiError | null;
  /** Re-run the fetch — after a create, an edit, or a failed attempt. */
  reload: () => void;
}

export function useResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [nonce, setNonce] = useState(0);

  // The caller passes a fresh closure every render; `deps` is what decides when to re-run,
  // exactly as it would for the `useEffect` this wraps.

  const loader = useCallback(load, deps);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);

    void (async () => {
      try {
        const result = await loader(controller.signal);
        if (!controller.signal.aborted) {
          setData(result);
          setError(null);
        }
      } catch (caught) {
        if (controller.signal.aborted) return;
        setError(
          caught instanceof ApiError
            ? caught
            : new ApiError(0, { code: 'network', message: 'Could not reach the server.' }),
        );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [loader, nonce]);

  return { data, loading, error, reload: () => setNonce((value) => value + 1) };
}
