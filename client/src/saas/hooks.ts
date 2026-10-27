import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { errText } from './state';

/** Small fetch hook — the SaaS SPA does not need the core dashboard's React
 *  Query setup, and keeping it independent avoids touching that code. */
export function useData<T = any>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(path));

  const reload = useCallback(async () => {
    if (!path) { setLoading(false); return; }
    setLoading(true);
    try {
      const result = await api.get<T>(path);
      setData(result);
      setError(null);
    } catch (err) {
      setError(errText(err));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);

  useEffect(() => { void reload(); }, [reload]);
  return { data, error, loading, reload, setData };
}

export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (fn: () => Promise<unknown>, onOk?: (result: any) => void) => {
    setBusy(true); setError(null);
    try {
      const result = await fn();
      onOk?.(result);
      return result;
    } catch (err) {
      setError(errText(err));
      return null;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, setError };
}
