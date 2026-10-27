import { Router } from 'express';
import { getDb } from '../../db/index.js';
import { hashPassword, verifyPassword } from '../../lib/password.js';
import {
  createAccount, devVerificationToken, login, logout, requestPasswordReset,
  resetPassword, serializeUser, verifyEmail,
} from '../auth/service.js';
import { audit } from '../audit.js';
import { errors } from '../errors.js';
import { actor, clearSessionCookie, requestIp, requireSaasAuth, sessionToken, setSessionCookie, userAgent } from '../middleware.js';
import type { AuthedRequest } from '../middleware.js';
import { resolveSubscription, subscriptionView } from '../subscriptions/service.js';
import { nowMs } from '../util.js';
import { route } from '../util.js';

export const saasAuthRouter = Router();

/** POST /api/saas/auth/signup — create user + tenant + default settings + FREE subscription. */
saasAuthRouter.post('/signup', route((req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = createAccount({
    name: String(body.name ?? ''),
    email: String(body.email ?? ''),
    password: String(body.password ?? ''),
    confirmPassword: body.confirmPassword === undefined ? undefined : String(body.confirmPassword),
    referralCode: body.referralCode ? String(body.referralCode) : undefined,
    ip: requestIp(req), userAgent: userAgent(req),
  });
  setSessionCookie(res, result.token);
  res.status(201).json({
    token: result.token,
    user: serializeUser(result.user),
    tenant: { id: result.tenant.id, name: result.tenant.name, status: result.tenant.status },
  });
}));

/** POST /api/saas/auth/login */
saasAuthRouter.post('/login', route((req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = login({
    email: String(body.email ?? ''), password: String(body.password ?? ''),
    ip: requestIp(req), userAgent: userAgent(req),
  });
  setSessionCookie(res, result.token);
  res.json({
    token: result.token,
    user: serializeUser(result.user),
    tenant: { id: result.tenant.id, name: result.tenant.name, status: result.tenant.status },
  });
}));

/** POST /api/saas/auth/logout — invalidates the session server-side too. */
saasAuthRouter.post('/logout', route((req, res) => {
  logout(sessionToken(req));
  clearSessionCookie(res);
  res.json({ ok: true });
}));

/** GET /api/saas/auth/me — identity + subscription, tenant-scoped. */
saasAuthRouter.get('/me', requireSaasAuth, route((req, res) => {
  const { saasUser, saasTenantId } = req as AuthedRequest;
  const { subscription, plan } = resolveSubscription(saasTenantId);
  const verification = process.env.NODE_ENV === 'production' ? undefined : devVerificationToken(saasUser.email);
  res.json({
    user: serializeUser(saasUser),
    subscription: subscriptionView(subscription),
    plan,
    devVerificationToken: verification,
  });
}));

/** POST /api/saas/auth/forgot-password — always 200 (no account enumeration). */
saasAuthRouter.post('/forgot-password', route((req, res) => {
  const email = String((req.body as Record<string, unknown> | undefined)?.email ?? '');
  const result = requestPasswordReset(email);
  res.json({ ok: true, ...(result.devToken ? { devToken: result.devToken } : {}) });
}));

/** POST /api/saas/auth/reset-password */
saasAuthRouter.post('/reset-password', route((req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  resetPassword(String(body.token ?? ''), String(body.password ?? ''));
  res.json({ ok: true });
}));

/** POST /api/saas/auth/verify-email */
saasAuthRouter.post('/verify-email', route((req, res) => {
  const token = String((req.body as Record<string, unknown> | undefined)?.token ?? '');
  if (!verifyEmail(token)) errors.badRequest('This verification link is invalid or has expired.');
  res.json({ ok: true });
}));

/** POST /api/saas/auth/change-password — session required, invalidates others. */
saasAuthRouter.post('/change-password', requireSaasAuth, route((req, res) => {
  const { saasUser } = req as AuthedRequest;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const current = String(body.currentPassword ?? '');
  const next = String(body.newPassword ?? '');
  if (!verifyPassword(current, saasUser.password_hash)) errors.invalidCredentials();
  if (next.length < 8) errors.badRequest('New password must be at least 8 characters.');
  const db = getDb();
  db.transaction(() => {
    db.prepare('UPDATE saas_users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hashPassword(next), nowMs(), saasUser.id);
    db.prepare('DELETE FROM saas_sessions WHERE user_id = ?').run(saasUser.id);
  })();
  audit({ actor: actor(req), action: 'user.password_changed', targetType: 'user', targetId: saasUser.id, ip: requestIp(req) });
  clearSessionCookie(res);
  res.json({ ok: true, signedOut: true });
}));
