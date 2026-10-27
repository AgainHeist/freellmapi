import crypto from 'crypto';
import { getDb } from '../../db/index.js';
import { hashPassword, verifyPassword } from '../../lib/password.js';
import { bootstrapAdmin } from '../config.js';
import { enqueueEmail } from '../email.js';
import { audit } from '../audit.js';
import { errors } from '../errors.js';
import { getPlanBySlug } from '../plans/service.js';
import { publicBaseUrl } from '../config.js';
import type { PlanRow, SessionRow, TenantRow, UserRow } from '../types.js';
import { isValidEmail, newId, normalizeEmail, nowMs, parseJson, randomToken, sha256 } from '../util.js';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;
const VERIFY_TTL_MS = 48 * 60 * 60 * 1000;
export const SESSION_COOKIE = 'ali_boss_session';

// Login brute-force throttle. Bucketed by (email, IP) so one attacker cannot
// lock every user out by spraying a shared IP, and one user cannot be guessed
// from many IPs without hitting their own bucket.
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
const attempts = new Map<string, { count: number; lockedUntil: number }>();

function throttleKey(email: string, ip: string): string {
  return `${normalizeEmail(email)}|${ip}`;
}

function assertNotLocked(email: string, ip: string): void {
  const a = attempts.get(throttleKey(email, ip));
  if (a && a.lockedUntil > Date.now()) {
    errors.rateLimit('Too many failed sign-in attempts. Try again in 15 minutes.');
  }
}

function recordFailure(email: string, ip: string): void {
  const key = throttleKey(email, ip);
  const a = attempts.get(key) ?? { count: 0, lockedUntil: 0 };
  a.count++;
  if (a.count >= MAX_LOGIN_ATTEMPTS) {
    a.lockedUntil = Date.now() + LOGIN_LOCKOUT_MS;
    a.count = 0;
  }
  attempts.set(key, a);
  if (attempts.size > 10_000) {
    const now = Date.now();
    for (const [k, state] of attempts) if (state.lockedUntil <= now) attempts.delete(k);
  }
}

export interface PublicUser {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  role: 'user' | 'admin';
  status: 'active' | 'suspended';
  emailVerified: boolean;
  referralCode: string | null;
  createdAt: number;
}

export function serializeUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    email: row.email,
    name: row.name,
    role: row.role,
    status: row.status,
    emailVerified: Boolean(row.email_verified),
    referralCode: row.referral_code,
    createdAt: row.created_at,
  };
}

export function getUserById(id: string): UserRow | undefined {
  return getDb().prepare('SELECT * FROM saas_users WHERE id = ?').get(id) as UserRow | undefined;
}

export function getUserByEmail(email: string): UserRow | undefined {
  return getDb().prepare('SELECT * FROM saas_users WHERE email = ?').get(normalizeEmail(email)) as UserRow | undefined;
}

export function getTenant(tenantId: string): TenantRow | undefined {
  return getDb().prepare('SELECT * FROM saas_tenants WHERE id = ?').get(tenantId) as TenantRow | undefined;
}

/** The default FREE subscription never expires in practice; paid plans get a
 *  real end date when a verified payment activates them. */
const FREE_SUB_DURATION_MS = 10 * 365 * 24 * 60 * 60 * 1000;

export function createAccount(input: {
  name: string;
  email: string;
  password: string;
  confirmPassword?: string;
  referralCode?: string;
  role?: 'user' | 'admin';
  ip?: string | null;
  userAgent?: string | null;
}): { user: UserRow; tenant: TenantRow; token: string } {
  const name = (input.name ?? '').trim();
  const email = normalizeEmail(input.email ?? '');
  const password = input.password ?? '';

  if (name.length < 2 || name.length > 120) errors.badRequest('Name must be between 2 and 120 characters.');
  if (!isValidEmail(email)) errors.badRequest('Enter a valid email address.');
  if (password.length < 8 || password.length > 200) errors.badRequest('Password must be at least 8 characters.');
  if (input.confirmPassword !== undefined && input.confirmPassword !== password) {
    errors.badRequest('Passwords do not match.');
  }

  const db = getDb();
  if (getUserByEmail(email)) errors.badRequest('An account with that email already exists.');

  const freePlan = getPlanBySlug('free');
  if (!freePlan) errors.payment('plans_not_seeded', 'Plans are not configured yet. Contact support.');

  const referrer = input.referralCode
    ? db.prepare('SELECT id FROM saas_users WHERE referral_code = ?').get(input.referralCode.trim()) as { id: string } | undefined
    : undefined;

  const now = nowMs();
  const tenantId = newId('ten');
  const userId = newId('usr');
  const token = randomToken();
  const passwordHash = hashPassword(password);
  const referralCode = crypto.randomBytes(5).toString('hex').toUpperCase();

  db.transaction(() => {
    db.prepare(`
      INSERT INTO saas_tenants (id, name, owner_user_id, status, settings_json, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?, ?)
    `).run(tenantId, `${name}'s workspace`, null, JSON.stringify({ defaultRouting: 'balanced' }), now, now);

    db.prepare(`
      INSERT INTO saas_users
        (id, tenant_id, email, name, password_hash, role, status, email_verified, referral_code, referred_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, ?, ?)
    `).run(userId, tenantId, email, name, passwordHash, input.role ?? 'user', referralCode, referrer?.id ?? null, now, now);

    db.prepare('UPDATE saas_tenants SET owner_user_id = ? WHERE id = ?').run(userId, tenantId);

    db.prepare(`
      INSERT INTO saas_subscriptions
        (id, tenant_id, plan_id, status, start_at, end_at, renewal_at, payment_id, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?, NULL, NULL, ?, ?)
    `).run(newId('sub'), tenantId, freePlan.id, now, now + FREE_SUB_DURATION_MS, now, now);

    db.prepare(`
      INSERT INTO saas_sessions (id, token_hash, user_id, tenant_id, expires_at, ip, user_agent, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(newId('sess'), sha256(token), userId, tenantId, now + SESSION_TTL_MS, input.ip ?? null, input.userAgent ?? null, now);
  })();

  const user = getUserById(userId)!;
  const tenant = getTenant(tenantId)!;

  // Verification + welcome mail are queued (never awaited) so signup cannot
  // fail because an email provider is down.
  const verifyToken = issueEmailVerification(userId);
  enqueueEmail(email, 'welcome', `Hi ${name},\n\nWelcome to ALI-BOSS. Your workspace is ready.\n\nGet started: ${publicBaseUrl()}/dashboard\n`);
  enqueueEmail(email, 'email_verification', `Verify your email: ${publicBaseUrl()}/verify-email?token=${verifyToken}\n`);
  audit({ actor: { id: user.id, email: user.email, role: user.role }, action: 'user.signup', targetType: 'user', targetId: user.id, ip: input.ip });

  return { user, tenant, token };
}

function issueEmailVerification(userId: string): string {
  const token = randomToken();
  getDb().prepare(`
    INSERT INTO saas_email_verifications (id, user_id, token_hash, expires_at, used_at, created_at)
    VALUES (?, ?, ?, ?, NULL, ?)
  `).run(newId('evrf'), userId, sha256(token), nowMs() + VERIFY_TTL_MS, nowMs());
  return token;
}

/** Dev-only helper: reads the queued verification mail for an address so a
 *  local install (or a test) can complete verification without an inbox.
 *  Returns null in production and never exposes a hashed token. */
export function devVerificationToken(email: string): string | null {
  if (process.env.NODE_ENV === 'production') return null;
  const mail = getDb().prepare(`
    SELECT body FROM saas_email_outbox
    WHERE to_email = ? AND template = 'email_verification'
    ORDER BY created_at DESC LIMIT 1
  `).get(normalizeEmail(email)) as { body: string } | undefined;
  const match = mail?.body.match(/token=([a-f0-9]{64})/);
  return match?.[1] ?? null;
}

export function login(input: { email: string; password: string; ip?: string | null; userAgent?: string | null }): { user: UserRow; tenant: TenantRow; token: string } {
  const email = normalizeEmail(input.email ?? '');
  const ip = input.ip ?? 'unknown';
  assertNotLocked(email, ip);

  const user = getUserByEmail(email);
  // Same failure shape and (roughly) same work whether or not the email exists:
  // hash a dummy password to keep the timing from being an account oracle.
  const hash = user?.password_hash ?? 'scrypt$00000000000000000000000000000000$' + '00'.repeat(64);
  const ok = verifyPassword(input.password ?? '', hash);
  if (!user || !ok) {
    recordFailure(email, ip);
    errors.invalidCredentials();
  }
  if (user.status === 'suspended') errors.forbidden();

  attempts.delete(throttleKey(email, ip));
  const tenant = getTenant(user.tenant_id);
  if (!tenant || tenant.status === 'suspended') errors.subscription('account_suspended', 'This account is suspended. Contact support.');

  const token = randomToken();
  getDb().prepare(`
    INSERT INTO saas_sessions (id, token_hash, user_id, tenant_id, expires_at, ip, user_agent, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(newId('sess'), sha256(token), user.id, user.tenant_id, nowMs() + SESSION_TTL_MS, input.ip ?? null, input.userAgent ?? null, nowMs());
  audit({ actor: { id: user.id, email: user.email, role: user.role }, action: 'user.login', targetType: 'user', targetId: user.id, ip });
  return { user, tenant, token };
}

export interface ResolvedSession {
  user: UserRow;
  tenant: TenantRow;
  session: SessionRow;
}

export function resolveSession(token: string | undefined | null): ResolvedSession | null {
  if (!token) return null;
  const db = getDb();
  const session = db.prepare('SELECT * FROM saas_sessions WHERE token_hash = ?').get(sha256(token)) as SessionRow | undefined;
  if (!session) return null;
  if (session.expires_at < nowMs()) {
    db.prepare('DELETE FROM saas_sessions WHERE id = ?').run(session.id);
    return null;
  }
  const user = getUserById(session.user_id);
  const tenant = getTenant(session.tenant_id);
  if (!user || !tenant || user.status !== 'active' || tenant.status !== 'active') return null;
  return { user, tenant, session };
}

export function logout(token: string | undefined | null): void {
  if (!token) return;
  getDb().prepare('DELETE FROM saas_sessions WHERE token_hash = ?').run(sha256(token));
}

/** Always succeeds from the caller's point of view: no account enumeration. */
export function requestPasswordReset(email: string): { devToken?: string } {
  const normalized = normalizeEmail(email ?? '');
  const user = getUserByEmail(normalized);
  if (!user) return {};
  const token = randomToken();
  getDb().prepare(`
    INSERT INTO saas_password_resets (id, user_id, token_hash, expires_at, used_at, created_at)
    VALUES (?, ?, ?, ?, NULL, ?)
  `).run(newId('prst'), user.id, sha256(token), nowMs() + RESET_TTL_MS, nowMs());
  enqueueEmail(user.email, 'password_reset', `Reset your password: ${publicBaseUrl()}/reset-password?token=${token}\n\nThis link expires in one hour.\n`);
  audit({ actor: { id: user.id, email: user.email, role: user.role }, action: 'user.password_reset_requested', targetType: 'user', targetId: user.id });
  return process.env.NODE_ENV === 'production' ? {} : { devToken: token };
}

export function resetPassword(token: string, newPassword: string): void {
  if (newPassword.length < 8) errors.badRequest('Password must be at least 8 characters.');
  const db = getDb();
  const row = db.prepare('SELECT * FROM saas_password_resets WHERE token_hash = ?').get(sha256(token)) as
    { id: string; user_id: string; expires_at: number; used_at: number | null } | undefined;
  if (!row || row.used_at || row.expires_at < nowMs()) errors.badRequest('This reset link is invalid or has expired.');
  db.transaction(() => {
    db.prepare('UPDATE saas_users SET password_hash = ?, updated_at = ? WHERE id = ?')
      .run(hashPassword(newPassword), nowMs(), row.user_id);
    db.prepare('UPDATE saas_password_resets SET used_at = ? WHERE id = ?').run(nowMs(), row.id);
    // A reset logs the account out everywhere, including the attacker.
    db.prepare('DELETE FROM saas_sessions WHERE user_id = ?').run(row.user_id);
  })();
}

export function verifyEmail(token: string): boolean {
  const db = getDb();
  const row = db.prepare('SELECT * FROM saas_email_verifications WHERE token_hash = ?').get(sha256(token)) as
    { id: string; user_id: string; expires_at: number; used_at: number | null } | undefined;
  if (!row || row.used_at || row.expires_at < nowMs()) return false;
  db.transaction(() => {
    db.prepare('UPDATE saas_users SET email_verified = 1, updated_at = ? WHERE id = ?').run(nowMs(), row.user_id);
    db.prepare('UPDATE saas_email_verifications SET used_at = ? WHERE id = ?').run(nowMs(), row.id);
  })();
  return true;
}

/** Idempotent first-boot admin creation from SAAS_ADMIN_EMAIL / _PASSWORD.
 *  Also used by scripts/saas-bootstrap-admin.ts. Never logs the password. */
export function ensureBootstrapAdmin(): void {
  const cfg = bootstrapAdmin();
  if (!cfg) return;
  if (getUserByEmail(cfg.email)) {
    // Promote an existing account only if it is already an admin; never
    // silently escalate a customer account because someone set an env var.
    return;
  }
  const account = createAccount({
    name: 'ALi-JDHD', email: cfg.email, password: cfg.password, role: 'admin',
  });
  const db = getDb();
  db.prepare('UPDATE saas_users SET email_verified = 1 WHERE id = ?').run(account.user.id);
  const business = getPlanBySlug('business') as PlanRow | undefined;
  if (business) {
    const now = nowMs();
    db.prepare('UPDATE saas_subscriptions SET plan_id = ?, status = ?, end_at = ?, updated_at = ? WHERE tenant_id = ? AND status IN (\'trial\',\'active\',\'past_due\')')
      .run(business.id, 'active', now + FREE_SUB_DURATION_MS, now, account.tenant.id);
  }
  console.log(`[saas] bootstrap admin created: ${cfg.email}`);
}

export function tenantSettings(tenant: TenantRow): Record<string, unknown> {
  return parseJson<Record<string, unknown>>(tenant.settings_json, {});
}
