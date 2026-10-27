import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, clearSaasToken, getSaasToken, SAAS_UNAUTHORIZED, setSaasToken } from './api';

export interface SaasUser {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  role: 'user' | 'admin';
  status: string;
  emailVerified: boolean;
  referralCode: string | null;
  createdAt: number;
}

interface AuthState {
  user: SaasUser | null;
  loading: boolean;
  subscription: any | null;
  acceptToken: (token: string, user?: SaasUser) => void;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  user: null, loading: true, subscription: null,
  acceptToken: () => {}, signOut: async () => {}, refresh: async () => {},
});

export function SaasAuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SaasUser | null>(null);
  const [subscription, setSubscription] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!getSaasToken()) { setUser(null); setSubscription(null); setLoading(false); return; }
    try {
      const me = await api.get('/api/saas/auth/me');
      setUser(me.user);
      setSubscription(me.subscription);
    } catch {
      clearSaasToken();
      setUser(null);
      setSubscription(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const fn = () => { setUser(null); setSubscription(null); };
    window.addEventListener(SAAS_UNAUTHORIZED, fn);
    return () => window.removeEventListener(SAAS_UNAUTHORIZED, fn);
  }, []);

  const acceptToken = useCallback((token: string, nextUser?: SaasUser) => {
    setSaasToken(token);
    if (nextUser) setUser(nextUser);
    void refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    try { await api.post('/api/saas/auth/logout'); } catch { /* ignore */ }
    clearSaasToken();
    setUser(null);
    setSubscription(null);
  }, []);

  const value = useMemo(() => ({ user, loading, subscription, acceptToken, signOut, refresh }), [user, loading, subscription, acceptToken, signOut, refresh]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useSaasAuth(): AuthState {
  return useContext(AuthContext);
}

// ── Toasts ───────────────────────────────────────────────────────────────
interface ToastState { message: string; error: boolean }
const ToastContext = createContext<(message: string, error?: boolean) => void>(() => {});

export function SaasToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const notify = useCallback((message: string, error = false) => {
    setToast({ message, error });
    window.setTimeout(() => setToast(null), 4200);
  }, []);
  return (
    <ToastContext.Provider value={notify}>
      {children}
      {toast && <div className={`ab-toast ${toast.error ? 'error' : ''}`}>{toast.message}</div>}
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

/** Standard error text for any thrown value. */
export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
