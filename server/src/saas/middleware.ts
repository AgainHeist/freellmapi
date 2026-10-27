import type { NextFunction, Request, Response } from 'express';
import { resolveSession, SESSION_COOKIE, SESSION_TTL_MS } from './auth/service.js';
import { secureCookies } from './config.js';
import { saasError } from './errors.js';
import type { UserRow } from './types.js';
import { setSaasContext } from './util.js';

export function cookieValue(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

export function sessionToken(req: Request): string | undefined {
  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, '').trim();
  return auth || cookieValue(req, SESSION_COOKIE);
}

export function setSessionCookie(res: Response, token: string): void {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secureCookies()) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(res: Response): void {
  const parts = [`${SESSION_COOKIE}=`, 'HttpOnly', 'Path=/', 'SameSite=Lax', 'Max-Age=0'];
  if (secureCookies()) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

export interface AuthedRequest extends Request {
  saasUser: UserRow;
  saasTenantId: string;
}

/** Session identity is the ONLY trusted source of tenant id. Any tenant_id /
 *  user_id in a request body is ignored by every handler below. */
export function requireSaasAuth(req: Request, res: Response, next: NextFunction): void {
  // CSRF: a cookie-only mutation must come from our own origin. Bearer-based
  // clients (the SPA, mobile apps, API scripts) are not vulnerable to ambient
  // credentials and skip this check.
  const hasBearer = Boolean(req.headers.authorization?.startsWith('Bearer '));
  if (!hasBearer && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = (req.headers.origin ?? req.headers.referer ?? '').toString();
    let allowed = false;
    try {
      const url = new URL(origin);
      allowed = url.host === req.headers.host || url.host === new URL(process.env.SAAS_BASE_URL ?? `http://${req.headers.host}`).host;
    } catch { allowed = false; }
    if (!allowed) {
      saasError(res, 403, 'authorization_error', 'csrf_rejected', 'Cross-origin request rejected.');
      return;
    }
  }
  const session = resolveSession(sessionToken(req));
  if (!session) {
    saasError(res, 401, 'authentication_error', 'authentication_required', 'Sign in to continue.');
    return;
  }
  const authed = req as AuthedRequest;
  authed.saasUser = session.user;
  authed.saasTenantId = session.tenant.id;
  setSaasContext(req, { user: session.user, tenant: session.tenant });
  next();
}

export function requireSaasAdmin(req: Request, res: Response, next: NextFunction): void {
  const authed = req as AuthedRequest;
  if (!authed.saasUser || authed.saasUser.role !== 'admin') {
    saasError(res, 403, 'authorization_error', 'admin_required', 'Administrator access required.');
    return;
  }
  next();
}

export function actor(req: Request): Pick<UserRow, 'id' | 'email' | 'role'> {
  const u = (req as AuthedRequest).saasUser;
  return { id: u.id, email: u.email, role: u.role };
}

export function requestIp(req: Request): string | null {
  return req.socket.remoteAddress ?? req.ip ?? null;
}

export function userAgent(req: Request): string | null {
  return req.headers['user-agent']?.slice(0, 300) ?? null;
}
