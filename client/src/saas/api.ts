// ALI-BOSS client transport. Kept separate from the FreeLLMAPI dashboard's
// apiFetch so the two auth systems never share a token or a 401 handler.

const TOKEN_KEY = 'ali_boss_token';
export const SAAS_UNAUTHORIZED = 'ali-boss:unauthorized';
const BASE = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');

export function getSaasToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setSaasToken(token: string): void {
  try { localStorage.setItem(TOKEN_KEY, token); } catch { /* private mode */ }
}
export function clearSaasToken(): void {
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ }
}

export class SaasApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function saasFetch<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getSaasToken();
  const headers = new Headers(options.headers);
  if (!(options.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const res = await fetch(`${BASE}${path}`, { ...options, headers });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }

  if (!res.ok) {
    const message = body?.error?.message ?? `Request failed (${res.status})`;
    const code = body?.error?.code;
    if (res.status === 401 && code === 'authentication_required') {
      clearSaasToken();
      window.dispatchEvent(new CustomEvent(SAAS_UNAUTHORIZED));
    }
    throw new SaasApiError(message, res.status, code);
  }
  return body as T;
}

export const api = {
  get: <T = any>(path: string) => saasFetch<T>(path),
  post: <T = any>(path: string, body?: unknown) => saasFetch<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T = any>(path: string, body?: unknown) => saasFetch<T>(path, { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T = any>(path: string, body?: unknown) => saasFetch<T>(path, { method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body) }),
  del: <T = any>(path: string) => saasFetch<T>(path, { method: 'DELETE' }),
};

export function money(minor: number, currency = 'INR'): string {
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(minor / 100);
  } catch { return `${currency} ${(minor / 100).toFixed(2)}`; }
}

export function compact(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

export function date(ts: number | string | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(typeof ts === 'string' ? ts : ts);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function dateTime(ts: number | string | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(typeof ts === 'string' ? ts : ts);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}
