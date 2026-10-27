import { Router } from 'express';
import { getDb } from '../../db/index.js';
import { audit } from '../audit.js';
import { dispatchOutbox } from '../email.js';
import { errors } from '../errors.js';
import { actor, requestIp, requireSaasAdmin, requireSaasAuth } from '../middleware.js';
import { adminRefund, getPaymentById, publicPayment, revenueSummary } from '../payments/service.js';
import { createPlan, listPlans, publicPlan, updatePlan } from '../plans/service.js';
import {
  adminChangePlan, adminExtendSubscription, adminSetSubscriptionStatus,
  liveSubscription, subscriptionView,
} from '../subscriptions/service.js';
import { globalUsageStats } from '../usage/service.js';
import { nowMs, route } from '../util.js';

export const saasAdminRouter = Router();
saasAdminRouter.use(requireSaasAuth, requireSaasAdmin);

interface UserListRow {
  id: string; tenant_id: string; email: string; name: string; role: string;
  status: string; email_verified: number; created_at: number;
}

function publicAdminUser(row: UserListRow) {
  const sub = liveSubscription(row.tenant_id);
  return {
    id: row.id, tenantId: row.tenant_id, email: row.email, name: row.name,
    role: row.role, status: row.status, emailVerified: Boolean(row.email_verified),
    createdAt: row.created_at,
    subscription: sub ? subscriptionView(sub) : null,
  };
}

function logAdmin(req: Parameters<typeof actor>[0], action: string, targetType: string, targetId: string, metadata: Record<string, unknown> = {}): void {
  audit({ actor: actor(req), action, targetType, targetId, metadata, ip: requestIp(req) });
}

saasAdminRouter.get('/stats', route((_req, res) => {
  const db = getDb();
  const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { c: number }).c;
  const revenue = revenueSummary();
  const usage = globalUsageStats();
  res.json({
    totalUsers: count('SELECT COUNT(*) AS c FROM saas_users'),
    activeUsers: count("SELECT COUNT(*) AS c FROM saas_users WHERE status = 'active'"),
    activeSubscriptions: count("SELECT COUNT(*) AS c FROM saas_subscriptions WHERE status IN ('trial','active')"),
    paidSubscriptions: count("SELECT COUNT(*) AS c FROM saas_subscriptions WHERE status = 'active' AND payment_id IS NOT NULL"),
    monthlyRevenueMinor: revenue.month,
    totalRevenueMinor: revenue.total,
    totalPayments: count('SELECT COUNT(*) AS c FROM saas_payments'),
    successfulPayments: revenue.successful,
    pendingPayments: revenue.pending,
    apiRequests: usage.requests,
    tokensUsed: usage.tokens,
    failedRequests: usage.errors,
  });
}));

saasAdminRouter.get('/users', route((req, res) => {
  const search = String(req.query.search ?? '').trim();
  const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);
  const rows = search
    ? getDb().prepare('SELECT * FROM saas_users WHERE email LIKE ? OR name LIKE ? ORDER BY created_at DESC LIMIT ?')
      .all(`%${search}%`, `%${search}%`, limit) as UserListRow[]
    : getDb().prepare('SELECT * FROM saas_users ORDER BY created_at DESC LIMIT ?').all(limit) as UserListRow[];
  res.json({ users: rows.map(publicAdminUser) });
}));

saasAdminRouter.get('/users/:id', route((req, res) => {
  const row = getDb().prepare('SELECT * FROM saas_users WHERE id = ?').get(String(req.params.id)) as UserListRow | undefined;
  if (!row) errors.notFound('User');
  const usage = getDb().prepare(`
    SELECT COUNT(*) AS requests, COALESCE(SUM(total_tokens),0) AS tokens
    FROM saas_usage_records WHERE tenant_id = ?
  `).get(row.tenant_id) as { requests: number; tokens: number };
  res.json({
    ...publicAdminUser(row),
    usage,
    payments: (getDb().prepare('SELECT * FROM saas_payments WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 50').all(row.tenant_id) as { id: string }[])
      .map(p => publicPayment(getPaymentById(p.id)!)),
  });
}));

function targetTenant(userId: string): string {
  const row = getDb().prepare('SELECT tenant_id FROM saas_users WHERE id = ?').get(userId) as { tenant_id: string } | undefined;
  if (!row) errors.notFound('User');
  return row.tenant_id;
}

function setUserStatus(userId: string, status: 'active' | 'suspended'): void {
  getDb().prepare('UPDATE saas_users SET status = ?, updated_at = ? WHERE id = ?').run(status, nowMs(), userId);
  if (status === 'suspended') {
    // A suspended user's sessions and API keys stop working immediately.
    getDb().prepare('DELETE FROM saas_sessions WHERE user_id = ?').run(userId);
  }
}

saasAdminRouter.post('/users/:id/suspend', route((req, res) => {
  setUserStatus(String(req.params.id), 'suspended');
  logAdmin(req, 'user.suspended', 'user', String(req.params.id));
  res.json({ ok: true });
}));

saasAdminRouter.post('/users/:id/unsuspend', route((req, res) => {
  setUserStatus(String(req.params.id), 'active');
  logAdmin(req, 'user.unsuspended', 'user', String(req.params.id));
  res.json({ ok: true });
}));

saasAdminRouter.post('/users/:id/plan', route((req, res) => {
  const planId = String((req.body as Record<string, unknown> | undefined)?.planId ?? '');
  const sub = adminChangePlan(targetTenant(String(req.params.id)), planId, actor(req));
  logAdmin(req, 'subscription.plan_changed', 'user', String(req.params.id), { planId });
  res.json(subscriptionView(sub));
}));

saasAdminRouter.post('/users/:id/extend', route((req, res) => {
  const days = Number((req.body as Record<string, unknown> | undefined)?.days ?? 30);
  const sub = adminExtendSubscription(targetTenant(String(req.params.id)), days);
  if (!sub) errors.badRequest('days must be between 1 and 3650.');
  logAdmin(req, 'subscription.extended', 'user', String(req.params.id), { days });
  res.json(subscriptionView(sub));
}));

saasAdminRouter.post('/users/:id/cancel', route((req, res) => {
  const sub = adminSetSubscriptionStatus(targetTenant(String(req.params.id)), 'cancelled');
  logAdmin(req, 'subscription.cancelled', 'user', String(req.params.id));
  res.json(sub ? subscriptionView(sub) : { ok: true });
}));

saasAdminRouter.post('/users/:id/reset-api-access', route((req, res) => {
  const tid = targetTenant(String(req.params.id));
  getDb().prepare("UPDATE saas_api_keys SET status = 'revoked', revoked_at = ? WHERE tenant_id = ? AND status = 'active'")
    .run(nowMs(), tid);
  logAdmin(req, 'api_keys.reset', 'user', String(req.params.id));
  res.json({ ok: true });
}));

// ── Plans ─────────────────────────────────────────────────────────────────

saasAdminRouter.get('/plans', route((_req, res) => {
  res.json({ plans: listPlans(true).map(publicPlan) });
}));

saasAdminRouter.post('/plans', route((req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const plan = createPlan({
    slug: String(body.slug ?? ''), name: String(body.name ?? ''),
    priceMinor: Number(body.priceMinor ?? 0), currency: body.currency ? String(body.currency) : undefined,
    billingCycleDays: body.billingCycleDays ? Number(body.billingCycleDays) : undefined,
    limits: body.limits as never, features: body.features as string[] | undefined,
  });
  logAdmin(req, 'plan.created', 'plan', plan.id);
  res.status(201).json(publicPlan(plan));
}));

saasAdminRouter.patch('/plans/:id', route((req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const plan = updatePlan(String(req.params.id), {
    name: body.name === undefined ? undefined : String(body.name),
    priceMinor: body.priceMinor === undefined ? undefined : Number(body.priceMinor),
    currency: body.currency === undefined ? undefined : String(body.currency),
    billingCycleDays: body.billingCycleDays === undefined ? undefined : Number(body.billingCycleDays),
    limits: body.limits as never,
    features: body.features as string[] | undefined,
    isActive: body.isActive === undefined ? undefined : Boolean(body.isActive),
  });
  logAdmin(req, 'plan.updated', 'plan', plan.id, { changes: Object.keys(body) });
  res.json(publicPlan(plan));
}));

// ── Payments / revenue / subscriptions ────────────────────────────────────

saasAdminRouter.get('/payments', route((req, res) => {
  const status = String(req.query.status ?? '').trim();
  const limit = Math.min(Number(req.query.limit ?? 200) || 200, 1000);
  const rows = status
    ? getDb().prepare('SELECT * FROM saas_payments WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit)
    : getDb().prepare('SELECT * FROM saas_payments ORDER BY created_at DESC LIMIT ?').all(limit);
  res.json({ payments: (rows as { id: string }[]).map(r => publicPayment(getPaymentById(r.id)!)) });
}));

saasAdminRouter.post('/payments/:id/refund', route(async (req, res) => {
  const reason = String((req.body as Record<string, unknown> | undefined)?.reason ?? 'admin_request');
  const row = await adminRefund(String(req.params.id), actor(req), reason);
  res.json(publicPayment(row));
}));

saasAdminRouter.get('/revenue', route((_req, res) => {
  const summary = revenueSummary();
  const daily = getDb().prepare(`
    SELECT strftime('%Y-%m-%d', verified_at / 1000, 'unixepoch') AS day, SUM(amount_minor) AS amount
    FROM saas_payments WHERE status = 'paid' AND verified_at IS NOT NULL
    GROUP BY day ORDER BY day DESC LIMIT 30
  `).all() as { day: string; amount: number }[];
  res.json({ ...summary, daily });
}));

saasAdminRouter.get('/subscriptions', route((_req, res) => {
  const rows = getDb().prepare(`
    SELECT s.*, u.email, p.name AS plan_name FROM saas_subscriptions s
    JOIN saas_users u ON u.tenant_id = s.tenant_id
    JOIN saas_plans p ON p.id = s.plan_id
    ORDER BY s.created_at DESC LIMIT 500
  `).all() as Record<string, unknown>[];
  res.json({ subscriptions: rows });
}));

// ── Ops ───────────────────────────────────────────────────────────────────

saasAdminRouter.get('/webhooks', route((_req, res) => {
  const rows = getDb().prepare('SELECT * FROM saas_webhook_events ORDER BY received_at DESC LIMIT 200').all();
  res.json({ events: rows });
}));

saasAdminRouter.get('/audit-logs', route((_req, res) => {
  res.json({ logs: getDb().prepare('SELECT * FROM saas_audit_logs ORDER BY created_at DESC LIMIT 300').all() });
}));

saasAdminRouter.get('/email-outbox', route((_req, res) => {
  res.json({ emails: getDb().prepare('SELECT id, to_email, template, subject, status, created_at, sent_at, error FROM saas_email_outbox ORDER BY created_at DESC LIMIT 200').all() });
}));

saasAdminRouter.post('/email-outbox/flush', route(async (_req, res) => {
  const sent = await dispatchOutbox(50);
  res.json({ sent });
}));

saasAdminRouter.get('/system', route((_req, res) => {
  res.json({
    gateway: process.env.PAYMENT_GATEWAY ?? 'razorpay',
    paymentConfigured: Boolean(process.env.PAYMENT_KEY_ID && process.env.PAYMENT_KEY_SECRET && process.env.PAYMENT_WEBHOOK_SECRET) || process.env.PAYMENT_GATEWAY === 'mock',
    emailConfigured: Boolean(process.env.EMAIL_PROVIDER_KEY),
    database: process.env.DATABASE_URL ? 'external (DATABASE_URL set — adapter required)' : 'sqlite (FreeLLMAPI local DB)',
    nodeEnv: process.env.NODE_ENV ?? 'development',
    serverTime: new Date().toISOString(),
  });
}));
