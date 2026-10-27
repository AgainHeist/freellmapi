import { Readable } from 'node:stream';
import { Router } from 'express';
import { getDb } from '../../db/index.js';
import {
  createApiKey, deleteApiKey, listApiKeys, publicApiKey,
  revealApiKey, revokeApiKey, rotateApiKey,
} from '../apikeys/service.js';
import { getTenant, serializeUser } from '../auth/service.js';
import { audit } from '../audit.js';
import { internalBaseUrl, internalSecret } from '../config.js';
import { errors } from '../errors.js';
import { actor, requestIp, requireSaasAuth, type AuthedRequest } from '../middleware.js';
import { mockGateway, mockPaymentIdFor, mockSign } from '../payments/gateway.js';
import { adminRefund, createCheckout, listTenantPayments, processWebhook, publicPayment, verifyCheckout } from '../payments/service.js';
import { publicPlan } from '../plans/service.js';
import {
  addProviderKey, deleteProviderKey, listProviderKeys, publicProviderKey, setProviderKeyEnabled,
} from '../providerkeys/service.js';
import { resolveSubscription, subscriptionView } from '../subscriptions/service.js';
import { quotaSnapshot, tenantAnalytics } from '../usage/service.js';
import { nowMs, parseJson, route } from '../util.js';
import type { UserRow } from '../types.js';

export const saasCustomerRouter = Router();
saasCustomerRouter.use(requireSaasAuth);

function tenantId(req: Parameters<typeof actor>[0]): string {
  return (req as AuthedRequest).saasTenantId;
}

// ── Overview / subscription / usage ───────────────────────────────────────

saasCustomerRouter.get('/overview', route((req, res) => {
  const tid = tenantId(req);
  const { subscription, plan, limits } = resolveSubscription(tid);
  const quota = quotaSnapshot(tid, limits);
  const analytics = tenantAnalytics(tid, 30);
  const counts = {
    apiKeys: (getDb().prepare("SELECT COUNT(*) AS c FROM saas_api_keys WHERE tenant_id = ? AND status = 'active'").get(tid) as { c: number }).c,
    providers: (getDb().prepare('SELECT COUNT(*) AS c FROM saas_provider_keys WHERE tenant_id = ? AND enabled = 1').get(tid) as { c: number }).c,
  };
  res.json({
    plan: publicPlan(plan),
    subscription: subscriptionView(subscription),
    status: subscription.status,
    requests: analytics.totals.requests,
    tokens: analytics.totals.tokens,
    errors: analytics.totals.errors,
    remainingPercent: quota.remainingDayPercent,
    quota,
    counts,
    charts: analytics.daily,
  });
}));

saasCustomerRouter.get('/subscription', route((req, res) => {
  const { subscription, plan, limits } = resolveSubscription(tenantId(req));
  res.json({ subscription: subscriptionView(subscription), plan: publicPlan(plan), limits });
}));

saasCustomerRouter.get('/usage', route((req, res) => {
  const days = Number(req.query.days ?? 30);
  res.json(tenantAnalytics(tenantId(req), Number.isFinite(days) ? days : 30));
}));

saasCustomerRouter.get('/analytics', route((req, res) => {
  const days = Number(req.query.days ?? 30);
  res.json(tenantAnalytics(tenantId(req), Number.isFinite(days) ? days : 30));
}));

saasCustomerRouter.get('/billing', route((req, res) => {
  const tid = tenantId(req);
  const { subscription, plan } = resolveSubscription(tid);
  const invoices = getDb().prepare(`
    SELECT number, amount_minor, currency, issued_at FROM saas_invoices
    WHERE tenant_id = ? ORDER BY issued_at DESC LIMIT 50
  `).all(tid) as { number: string; amount_minor: number; currency: string; issued_at: number }[];
  res.json({
    subscription: subscriptionView(subscription),
    plan: publicPlan(plan),
    payments: listTenantPayments(tid).map(publicPayment),
    invoices: invoices.map(i => ({ number: i.number, amountMinor: i.amount_minor, currency: i.currency, issuedAt: i.issued_at })),
  });
}));

// ── API keys ──────────────────────────────────────────────────────────────

saasCustomerRouter.get('/api-keys', route((req, res) => {
  res.json({ keys: listApiKeys(tenantId(req)).map(publicApiKey) });
}));

saasCustomerRouter.post('/api-keys', route((req, res) => {
  const tid = tenantId(req);
  const name = String((req.body as Record<string, unknown> | undefined)?.name ?? 'Default');
  const created = createApiKey({ tenantId: tid, userId: (req as AuthedRequest).saasUser.id, name, actor: actor(req) });
  // The full key is returned ONCE, at creation, over the authenticated session.
  res.status(201).json({ ...publicApiKey(created.row), key: created.key });
}));

saasCustomerRouter.post('/api-keys/:id/reveal', route((req, res) => {
  res.json({ key: revealApiKey(tenantId(req), String(req.params.id), actor(req)) });
}));

saasCustomerRouter.post('/api-keys/:id/rotate', route((req, res) => {
  const created = rotateApiKey(tenantId(req), String(req.params.id), actor(req));
  res.status(201).json({ ...publicApiKey(created.row), key: created.key });
}));

saasCustomerRouter.post('/api-keys/:id/revoke', route((req, res) => {
  res.json(publicApiKey(revokeApiKey(tenantId(req), String(req.params.id), actor(req))));
}));

saasCustomerRouter.delete('/api-keys/:id', route((req, res) => {
  deleteApiKey(tenantId(req), String(req.params.id), actor(req));
  res.status(204).end();
}));

// ── Provider keys (tenant-scoped, encrypted, masked in responses) ──────────

saasCustomerRouter.get('/provider-keys', route((req, res) => {
  res.json({ keys: listProviderKeys(tenantId(req)).map(publicProviderKey) });
}));

saasCustomerRouter.post('/provider-keys', route((req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const key = addProviderKey({
    tenantId: tenantId(req),
    platform: String(body.platform ?? ''),
    label: String(body.label ?? ''),
    secret: String(body.secret ?? ''),
    baseUrl: body.baseUrl ? String(body.baseUrl) : undefined,
    actor: actor(req),
  });
  res.status(201).json(key);
}));

saasCustomerRouter.patch('/provider-keys/:id', route((req, res) => {
  const enabled = Boolean((req.body as Record<string, unknown> | undefined)?.enabled);
  res.json(setProviderKeyEnabled(tenantId(req), String(req.params.id), enabled, actor(req)));
}));

saasCustomerRouter.delete('/provider-keys/:id', route((req, res) => {
  deleteProviderKey(tenantId(req), String(req.params.id), actor(req));
  res.status(204).end();
}));

// ── Checkout ──────────────────────────────────────────────────────────────

saasCustomerRouter.post('/payments/order', route(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { subscription } = resolveSubscription(tenantId(req));
  if (['suspended', 'past_due'].includes(subscription.status)) {
    errors.subscription('subscription_not_payable', 'This account cannot start a checkout right now.');
  }
  const order = await createCheckout({
    user: (req as AuthedRequest).saasUser,
    planSlug: String(body.planSlug ?? body.plan ?? ''),
    idempotencyKey: body.idempotencyKey ? String(body.idempotencyKey) : undefined,
  });
  audit({ actor: actor(req), action: 'payment.order_created', targetType: 'payment', targetId: order.paymentId, ip: requestIp(req) });
  res.status(201).json(order);
}));

saasCustomerRouter.post('/payments/verify', route(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = await verifyCheckout({
    tenantId: tenantId(req),
    orderId: String(body.orderId ?? body.razorpay_order_id ?? ''),
    paymentId: String(body.paymentId ?? body.razorpay_payment_id ?? ''),
    signature: String(body.signature ?? body.razorpay_signature ?? ''),
    actor: actor(req),
  });
  res.json(result);
}));

saasCustomerRouter.get('/payments', route((req, res) => {
  res.json({ payments: listTenantPayments(tenantId(req)).map(publicPayment) });
}));

/**
 * Local-development checkout for PAYMENT_GATEWAY=mock. It does NOT bypass
 * verification: it constructs a gateway-shaped webhook and pushes it through
 * processWebhook() with a real HMAC signature and a fresh event id, so the
 * exact production activation path (signature → dedup → amount match →
 * subscription) is exercised. Disabled in production and for any real gateway.
 */
saasCustomerRouter.post('/payments/dev-capture', route((req, res) => {
  if (process.env.PAYMENT_GATEWAY !== 'mock' || process.env.NODE_ENV === 'production') {
    errors.notFound('Endpoint');
  }
  const orderId = String((req.body as Record<string, unknown> | undefined)?.orderId ?? '');
  const row = getDb().prepare('SELECT * FROM saas_payments WHERE order_id = ? AND tenant_id = ?')
    .get(orderId, tenantId(req)) as { id: string; status: string; amount_minor: number; currency: string } | undefined;
  if (!row || row.status !== 'pending') errors.badRequest('No pending order to capture.');
  const payload = {
    event: 'payment.captured',
    payload: { payment: { entity: {
      id: mockPaymentIdFor(orderId), order_id: orderId,
      amount: row.amount_minor, currency: row.currency, status: 'captured',
    } } },
  };
  const raw = JSON.stringify(payload);
  const signature = mockSign(raw);
  const result = processWebhook({
    gatewayName: 'mock',
    eventId: `dev_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    eventType: 'payment.captured',
    rawBody: raw,
    signatureValid: mockGateway.verifyWebhookSignature(raw, signature),
    payload,
  });
  audit({ actor: actor(req), action: 'payment.dev_capture', targetType: 'payment', targetId: row.id, ip: requestIp(req) });
  res.json(result);
}));

// Admin-only refund is exposed here too so the admin panel can share the
// client transport; the handler re-checks the role.
saasCustomerRouter.post('/payments/:id/refund', route(async (req, res) => {
  if ((req as AuthedRequest).saasUser.role !== 'admin') errors.forbidden();
  const row = await adminRefund(String(req.params.id), actor(req));
  res.json(publicPayment(row));
}));

// ── Models / routing / account ────────────────────────────────────────────

saasCustomerRouter.get('/catalog', route((req, res) => {
  const { plan, limits } = resolveSubscription(tenantId(req));
  const rows = getDb().prepare(`
    SELECT * FROM models WHERE enabled = 1 ORDER BY intelligence_rank ASC, speed_rank ASC LIMIT ?
  `).all(Math.min(limits.maxModels, 635)) as Record<string, unknown>[];
  res.json({
    plan: plan.name,
    limit: limits.maxModels,
    models: rows.map(r => ({
      id: r.model_id, name: r.display_name, provider: r.platform,
      context: r.context_window, vision: Boolean(r.supports_vision), tools: Boolean(r.supports_tools),
    })),
  });
}));

saasCustomerRouter.get('/routing', route((req, res) => {
  const tenant = getTenant(tenantId(req));
  const settings = parseJson<Record<string, unknown>>(tenant?.settings_json, {});
  res.json({
    primary: settings.primaryProvider ?? null,
    secondary: settings.secondaryProvider ?? null,
    fallback: settings.fallbackProvider ?? null,
    strategy: settings.defaultRouting ?? 'balanced',
  });
}));

saasCustomerRouter.put('/routing', route((req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const tenant = getTenant(tenantId(req));
  if (!tenant) errors.notFound('Tenant');
  const settings = {
    ...parseJson<Record<string, unknown>>(tenant.settings_json, {}),
    primaryProvider: body.primary ? String(body.primary).slice(0, 60) : null,
    secondaryProvider: body.secondary ? String(body.secondary).slice(0, 60) : null,
    fallbackProvider: body.fallback ? String(body.fallback).slice(0, 60) : null,
    defaultRouting: ['balanced', 'speed', 'quality'].includes(String(body.strategy)) ? String(body.strategy) : 'balanced',
  };
  getDb().prepare('UPDATE saas_tenants SET settings_json = ?, updated_at = ? WHERE id = ? AND owner_user_id IS NOT NULL')
    .run(JSON.stringify(settings), nowMs(), tenant.id);
  audit({ actor: actor(req), action: 'routing.updated', targetType: 'tenant', targetId: tenant.id, metadata: settings, ip: requestIp(req) });
  res.json(settings);
}));

saasCustomerRouter.get('/account', route((req, res) => {
  const user = (req as AuthedRequest).saasUser;
  const tenant = getTenant(tenantId(req));
  res.json({ user: serializeUser(user), tenant: tenant ? { id: tenant.id, name: tenant.name, status: tenant.status } : null });
}));

saasCustomerRouter.patch('/account', route((req, res) => {
  const user = (req as AuthedRequest).saasUser;
  const name = String((req.body as Record<string, unknown> | undefined)?.name ?? '').trim();
  if (name.length < 2 || name.length > 120) errors.badRequest('Name must be between 2 and 120 characters.');
  getDb().prepare('UPDATE saas_users SET name = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
    .run(name, nowMs(), user.id, tenantId(req));
  audit({ actor: actor(req), action: 'account.updated', targetType: 'user', targetId: user.id });
  const updated = getDb().prepare('SELECT * FROM saas_users WHERE id = ?').get(user.id) as UserRow;
  res.json({ user: serializeUser(updated) });
}));

// ── Playground ────────────────────────────────────────────────────────────
// Re-enters the SAME Express app over loopback with an internal identity, so
// the request passes through the SaaS gateway (quota/usage) and then the
// ORIGINAL FreeLLMAPI router. Nothing about streaming is re-implemented here.

saasCustomerRouter.post('/playground/run', route(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { limits } = resolveSubscription(tenantId(req));
  if (body.stream === true && !limits.streaming) {
    errors.subscription('streaming_not_allowed', 'Streaming is not included in your plan.');
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const payload = {
    model: String(body.model ?? ''),
    messages: [
      ...(body.systemPrompt ? [{ role: 'system', content: String(body.systemPrompt).slice(0, 8000) }] : []),
      ...messages.slice(-30),
    ],
    temperature: typeof body.temperature === 'number' ? body.temperature : 0.7,
    max_tokens: typeof body.maxTokens === 'number' ? Math.min(body.maxTokens, 8192) : 1024,
    stream: Boolean(body.stream),
  };
  if (!payload.model) errors.badRequest('Choose a model.');

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(`${internalBaseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ali-boss-internal': internalSecret(),
        'x-ali-boss-tenant': tenantId(req),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120000),
    });
  } catch (err) {
    res.status(502).json({ error: { message: 'Router is unavailable.', type: 'server_error', code: 'router_unavailable', detail: String((err as Error).message) } });
    return;
  }

  res.status(upstream.status);
  const contentType = upstream.headers.get('content-type') ?? 'application/json';
  res.setHeader('Content-Type', contentType);
  const reqId = upstream.headers.get('X-Request-ID') ?? upstream.headers.get('X-ALI-BOSS-Request-ID');
  if (reqId) res.setHeader('X-Request-ID', reqId);
  for (const [k, v] of upstream.headers) {
    if (k.toLowerCase().startsWith('x-provider') || k.toLowerCase().startsWith('x-model')) res.setHeader(k, v);
  }

  if (payload.stream && upstream.body) {
    Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
  } else {
    const text = await upstream.text();
    res.send(text);
  }
}));
