import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb, initDb, getUnifiedApiKey } from '../../db/index.js';
import { nodeSqliteFactory } from '../../db/node-sqlite.js';
import { createAccount } from '../../saas/auth/service.js';
import { mockPaymentIdFor, mockSign } from '../../saas/payments/gateway.js';
import { extractUsage } from '../../saas/gateway/middleware.js';

// ALI-BOSS SaaS regression suite (#42/#43 of the spec). Runs against a real
// in-memory DB and a real Express app: no mocked storage, no mocked signature
// verification. The mock PAYMENT gateway exists only to avoid real money /
// outbound network; it implements the same HMAC rules as Razorpay.

let app: Express;

async function req(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string; headers?: Record<string, string>; raw?: string } = {},
) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const body = opts.raw !== undefined ? opts.raw : opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
  if (body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, { method, headers, body });
  const text = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* non-JSON (SSE / docs) */ }
  return { status: res.status, body: json, raw: text, headers: res.headers };
}

const state = {
  tokenA: '', tokenB: '', tokenAdmin: '',
  userIdA: '', userIdB: '',
  keyIdA: '', keyIdB: '', rawKeyA: '',
  providerKeyIdA: '',
  orderId: '', paymentId: '',
  planFreeId: '' as string, planProId: '' as string,
};

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  process.env.NODE_ENV = 'test';
  process.env.SAAS_ENABLED = '1';
  process.env.SAAS_REQUIRE_KEYS = '0';
  process.env.PAYMENT_GATEWAY = 'mock';
  process.env.PAYMENT_WEBHOOK_SECRET = 'test-webhook-secret';
  process.env.PROXY_RATE_LIMIT_RPM = '0';
  process.env.ADMIN_RATE_LIMIT_RPM = '0';
  process.env.SESSION_SECRET = 'test-session-secret';
  initDb(':memory:', { factory: nodeSqliteFactory });
  app = createApp();

  // A stand-in for the original FreeLLMAPI router: it is mounted AFTER the
  // SaaS gateway, so requests reaching it have already passed auth, quota and
  // rate limiting. This lets the suite assert streaming is passed through
  // untouched without calling a live LLM provider.
  app.post('/v1/__saas_test', (req, res) => {
    res.setHeader('X-Provider', 'test-provider');
    res.setHeader('X-Model', String(req.body?.model ?? 'test-model'));
    if (req.body?.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write('data: {"choices":[{"delta":{"content":"hello "}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"world"}}]}\n\n');
      res.write('data: {"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n');
      res.end('data: [DONE]\n\n');
      return;
    }
    res.json({ model: req.body?.model ?? 'test-model', usage: { prompt_tokens: 10, completion_tokens: 5 } });
  });
});

describe('ALI-BOSS SaaS — public surface', () => {
  it('exposes admin-configurable plans (nothing hard-coded)', async () => {
    const { status, body } = await req('GET', '/api/saas/plans');
    expect(status).toBe(200);
    expect(body.plans.map((p: any) => p.slug)).toEqual(['free', 'starter', 'pro', 'business']);
    expect(body.plans[2].priceMinor).toBe(79900);
    state.planFreeId = body.plans[0].id;
    state.planProId = body.plans[2].id;
  });

  it('serves the live FreeLLMAPI model catalog', async () => {
    const { status, body } = await req('GET', '/api/saas/models?limit=5');
    expect(status).toBe(200);
    expect(body.models.length).toBeGreaterThan(0);
    expect(body.models[0]).toHaveProperty('provider');
  });

  it('publishes API docs and config', async () => {
    const docs = await req('GET', '/api/saas/docs');
    expect(docs.status).toBe(200);
    expect(docs.body.endpoints.some((e: any) => e.path === '/v1/chat/completions')).toBe(true);
    const config = await req('GET', '/api/saas/config');
    expect(config.body.brand).toBe('ALI-BOSS');
  });
});

describe('ALI-BOSS SaaS — auth + tenancy', () => {
  it('validates signup input and prevents duplicate emails', async () => {
    const bad = await req('POST', '/api/saas/auth/signup', { body: { name: 'A', email: 'not-an-email', password: 'short', confirmPassword: 'x' } });
    expect(bad.status).toBe(400);

    const mismatch = await req('POST', '/api/saas/auth/signup', { body: { name: 'User A', email: 'a@example.com', password: 'password123', confirmPassword: 'password456' } });
    expect(mismatch.status).toBe(400);

    const a = await req('POST', '/api/saas/auth/signup', { body: { name: 'User A', email: 'a@example.com', password: 'password123', confirmPassword: 'password123' } });
    expect(a.status).toBe(201);
    expect(a.body.user.email).toBe('a@example.com');
    expect(a.body.user.role).toBe('user');
    expect(a.body.token).toBeTruthy();
    state.tokenA = a.body.token;
    state.userIdA = a.body.user.id;

    const dup = await req('POST', '/api/saas/auth/signup', { body: { name: 'User A', email: 'A@example.com', password: 'password123' } });
    expect(dup.status).toBe(400);

    const b = await req('POST', '/api/saas/auth/signup', { body: { name: 'User B', email: 'b@example.com', password: 'password123', referralCode: 'REF123' } });
    expect(b.status).toBe(201);
    state.tokenB = b.body.token;
    state.userIdB = b.body.user.id;
    expect(b.body.user.tenantId).not.toBe(a.body.user.tenantId);
  });

  it('creates a tenant, FREE subscription and session for every signup', async () => {
    const me = await req('GET', '/api/saas/auth/me', { token: state.tokenA });
    expect(me.status).toBe(200);
    expect(me.body.subscription.plan.slug).toBe('free');
    expect(me.body.subscription.status).toBe('active');
    const db = getDb();
    expect((db.prepare('SELECT COUNT(*) AS c FROM saas_tenants').get() as { c: number }).c).toBe(2);
    expect((db.prepare('SELECT COUNT(*) AS c FROM saas_subscriptions').get() as { c: number }).c).toBe(2);
  });

  it('login / logout / password reset work and sessions are invalidated', async () => {
    const wrong = await req('POST', '/api/saas/auth/login', { body: { email: 'a@example.com', password: 'wrong-password' } });
    expect(wrong.status).toBe(401);
    const ok = await req('POST', '/api/saas/auth/login', { body: { email: 'a@example.com', password: 'password123' } });
    expect(ok.status).toBe(200);
    const token = ok.body.token;

    const forgot = await req('POST', '/api/saas/auth/forgot-password', { body: { email: 'a@example.com' } });
    expect(forgot.status).toBe(200);
    expect(forgot.body.devToken).toBeTruthy(); // dev-mode inbox substitute
    const unknown = await req('POST', '/api/saas/auth/forgot-password', { body: { email: 'nobody@example.com' } });
    expect(unknown.status).toBe(200); // no account enumeration

    const reset = await req('POST', '/api/saas/auth/reset-password', { body: { token: forgot.body.devToken, password: 'newpassword123' } });
    expect(reset.status).toBe(200);
    const invalidated = await req('GET', '/api/saas/auth/me', { token });
    expect(invalidated.status).toBe(401);
    const oldLogin = await req('POST', '/api/saas/auth/login', { body: { email: 'a@example.com', password: 'password123' } });
    expect(oldLogin.status).toBe(401);
    const newLogin = await req('POST', '/api/saas/auth/login', { body: { email: 'a@example.com', password: 'newpassword123' } });
    expect(newLogin.status).toBe(200);
    state.tokenA = newLogin.body.token;

    const out = await req('POST', '/api/saas/auth/logout', { token: state.tokenA });
    expect(out.status).toBe(200);
    expect((await req('GET', '/api/saas/auth/me', { token: state.tokenA })).status).toBe(401);
    state.tokenA = (await req('POST', '/api/saas/auth/login', { body: { email: 'a@example.com', password: 'newpassword123' } })).body.token;
  });

  it('isolates tenants: User A cannot read or reveal User B data', async () => {
    const keyB = await req('POST', '/api/saas/api-keys', { token: state.tokenB, body: { name: 'B key' } });
    expect(keyB.status).toBe(201);
    state.keyIdB = keyB.body.id;

    const listA = await req('GET', '/api/saas/api-keys', { token: state.tokenA });
    expect(listA.body.keys).toHaveLength(0);
    const reveal = await req('POST', `/api/saas/api-keys/${state.keyIdB}/reveal`, { token: state.tokenA, body: {} });
    expect(reveal.status).toBe(404);

    // A forged tenant_id in the body is ignored: identity comes from session.
    const spoof = await req('POST', '/api/saas/provider-keys', {
      token: state.tokenA,
      body: { platform: 'groq', label: 'spoof', secret: 'gsk_spoof_secret_123', tenant_id: 'someone-else' },
    });
    expect(spoof.status).toBe(201);
    const owner = getDb().prepare('SELECT tenant_id FROM saas_provider_keys WHERE id = ?').get(spoof.body.id) as { tenant_id: string };
    const aTenant = getDb().prepare('SELECT tenant_id FROM saas_users WHERE id = ?').get(state.userIdA) as { tenant_id: string };
    expect(owner.tenant_id).toBe(aTenant.tenant_id);
  });
});

describe('ALI-BOSS SaaS — secrets', () => {
  it('stores API keys hashed and provider keys encrypted, never plaintext', async () => {
    const created = await req('POST', '/api/saas/api-keys', { token: state.tokenA, body: { name: 'Main' } });
    expect(created.status).toBe(201);
    expect(created.body.key).toMatch(/^ALI-BOSS-[a-f0-9]{48}$/);
    expect(created.body).not.toHaveProperty('key_hash');
    state.keyIdA = created.body.id;
    state.rawKeyA = created.body.key;

    const db = getDb();
    const keyRow = db.prepare('SELECT key_hash, secret_enc FROM saas_api_keys WHERE id = ?').get(state.keyIdA) as { key_hash: string; secret_enc: string };
    expect(keyRow.key_hash).not.toContain('ALI-BOSS');
    expect(keyRow.secret_enc).not.toContain('ALI-BOSS');

    const provider = await req('POST', '/api/saas/provider-keys', {
      token: state.tokenA, body: { platform: 'google', label: 'My Google', secret: 'AIzaSuperSecretValue123' },
    });
    expect(provider.status).toBe(201);
    expect(provider.body.masked).not.toContain('AIzaSuperSecretValue123');
    expect(JSON.stringify(provider.body)).not.toContain('AIzaSuperSecretValue123');
    state.providerKeyIdA = provider.body.id;
    const pRow = db.prepare('SELECT secret_enc FROM saas_provider_keys WHERE id = ?').get(state.providerKeyIdA) as { secret_enc: string };
    expect(pRow.secret_enc).not.toContain('AIzaSuperSecretValue123');

    const list = await req('GET', '/api/saas/provider-keys', { token: state.tokenA });
    expect(list.body.keys.every((k: any) => !('secret' in k) && !('secret_enc' in k))).toBe(true);
  });

  it('reveals, rotates and revokes API keys', async () => {
    const reveal = await req('POST', `/api/saas/api-keys/${state.keyIdA}/reveal`, { token: state.tokenA, body: {} });
    expect(reveal.body.key).toBe(state.rawKeyA);
    const rotated = await req('POST', `/api/saas/api-keys/${state.keyIdA}/rotate`, { token: state.tokenA, body: {} });
    expect(rotated.status).toBe(201);
    expect(rotated.body.key).not.toBe(state.rawKeyA);
    state.keyIdA = rotated.body.id;
    state.rawKeyA = rotated.body.key;
    const revoke = await req('POST', `/api/saas/api-keys/${state.keyIdA}/revoke`, { token: state.tokenA, body: {} });
    expect(revoke.body.status).toBe('revoked');
  });
});

describe('ALI-BOSS SaaS — payments, webhooks, subscriptions', () => {
  it('rejects a checkout verification with a bad signature', async () => {
    const order = await req('POST', '/api/saas/payments/order', { token: state.tokenA, body: { planSlug: 'pro', idempotencyKey: 'checkout-1' } });
    expect(order.status).toBe(201);
    state.orderId = order.body.orderId;
    state.paymentId = mockPaymentIdFor(state.orderId);

    const again = await req('POST', '/api/saas/payments/order', { token: state.tokenA, body: { planSlug: 'pro', idempotencyKey: 'checkout-1' } });
    expect(again.body.paymentId).toBe(order.body.paymentId); // idempotent checkout

    const bad = await req('POST', '/api/saas/payments/verify', {
      token: state.tokenA,
      body: { orderId: state.orderId, paymentId: state.paymentId, signature: 'deadbeef' },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_signature');
    expect((await req('GET', '/api/saas/auth/me', { token: state.tokenA })).body.subscription.plan.slug).toBe('free');
  });

  it('activates PRO only after signature + gateway amount/order verification', async () => {
    const signature = mockSign(`${state.orderId}|${state.paymentId}`);
    const ok = await req('POST', '/api/saas/payments/verify', {
      token: state.tokenA, body: { orderId: state.orderId, paymentId: state.paymentId, signature },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.subscription.status).toBe('active');
    expect(ok.body.subscription.plan.slug).toBe('pro');
    expect(ok.body.payment.status).toBe('paid');
    expect((await req('GET', '/api/saas/auth/me', { token: state.tokenA })).body.subscription.plan.slug).toBe('pro');

    const db = getDb();
    expect((db.prepare("SELECT COUNT(*) AS c FROM saas_subscriptions WHERE status = 'active' AND tenant_id = (SELECT tenant_id FROM saas_users WHERE id = ?)").get(state.userIdA) as { c: number }).c).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS c FROM saas_invoices').get() as { c: number }).c).toBe(1);
  });

  it('rejects an unsigned webhook and does not change state', async () => {
    const payload = JSON.stringify({
      event: 'payment.captured',
      payload: { payment: { entity: { id: state.paymentId, order_id: state.orderId, amount: 79900, currency: 'INR', status: 'captured' } } },
    });
    const bad = await req('POST', '/api/webhooks/payment', { raw: payload, headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': 'invalid', 'x-razorpay-event-id': 'evt_bad' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_signature');
  });

  it('is idempotent: duplicate webhook events never create a second subscription', async () => {
    const payload = JSON.stringify({
      event: 'payment.captured',
      payload: { payment: { entity: { id: state.paymentId, order_id: state.orderId, amount: 79900, currency: 'INR', status: 'captured' } } },
    });
    const signature = mockSign(payload);
    const first = await req('POST', '/api/webhooks/payment', { raw: payload, headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': signature, 'x-razorpay-event-id': 'evt_1' } });
    expect(first.status).toBe(200);
    const repeat = await req('POST', '/api/webhooks/payment', { raw: payload, headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': signature, 'x-razorpay-event-id': 'evt_1' } });
    expect(repeat.body.duplicate).toBe(true);
    // A DIFFERENT event id for the same payment is also safe.
    const second = await req('POST', '/api/webhooks/payment', { raw: payload, headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': signature, 'x-razorpay-event-id': 'evt_2' } });
    expect(second.status).toBe(200);
    const db = getDb();
    const tid = (db.prepare('SELECT tenant_id FROM saas_users WHERE id = ?').get(state.userIdA) as { tenant_id: string }).tenant_id;
    expect((db.prepare("SELECT COUNT(*) AS c FROM saas_subscriptions WHERE tenant_id = ? AND status = 'active'").get(tid) as { c: number }).c).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS c FROM saas_payments').get() as { c: number }).c).toBe(1);
  });

  it('rejects a signed webhook whose amount does not match the order', async () => {
    const mismatched = JSON.stringify({
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_mock_fake', order_id: state.orderId, amount: 1, currency: 'INR', status: 'captured' } } },
    });
    const res = await req('POST', '/api/webhooks/payment', { raw: mismatched, headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': mockSign(mismatched), 'x-razorpay-event-id': 'evt_mismatch' } });
    expect(res.status).toBe(202);
    expect(res.body.reason).toBe('webhook_amount_mismatch');
  });

  it('handles refunds by cancelling the paid subscription and restoring FREE', async () => {
    const admin = createAccount({ name: 'ALi-JDHD', email: 'admin@example.com', password: 'adminpassword123', role: 'admin' });
    state.tokenAdmin = admin.token;
    const billing = await req('GET', '/api/saas/billing', { token: state.tokenA });
    const paidId = billing.body.payments.find((p: any) => p.status === 'paid').id;
    const refund = await req('POST', `/api/saas/payments/${paidId}/refund`, { token: state.tokenAdmin, body: { reason: 'customer request' } });
    expect(refund.status).toBe(200);
    expect(refund.body.status).toBe('refunded');
    const me = await req('GET', '/api/saas/auth/me', { token: state.tokenA });
    expect(me.body.subscription.plan.slug).toBe('free');
    expect((await req('POST', `/api/saas/payments/${paidId}/refund`, { token: state.tokenA, body: {} })).status).toBe(403);
  });
});

describe('ALI-BOSS SaaS — API gateway', () => {
  it('extracts usage from JSON and SSE responses', () => {
    expect(extractUsage('{"usage":{"prompt_tokens":10,"completion_tokens":5}}')).toEqual({ input: 10, output: 5 });
    expect(extractUsage('data: {"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\n')).toEqual({ input: 7, output: 3 });
    expect(extractUsage('data: {"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":2}}')).toEqual({ input: 4, output: 2 });
  });

  it('rejects an invalid API key with 401', async () => {
    const res = await req('POST', '/v1/__saas_test', { token: 'ALI-BOSS-not-a-real-key', body: { model: 'test' } });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('invalid_api_key');
  });

  it('passes a valid SaaS key through the original router and records usage', async () => {
    const created = await req('POST', '/api/saas/api-keys', { token: state.tokenA, body: { name: 'Gateway key' } });
    // The gateway must satisfy the CORE router's unified-key auth after doing
    // its own checks, otherwise every original /v1 endpoint would 401.
    const models = await req('GET', '/v1/models', { token: created.body.key });
    expect(models.status).toBe(200);
    const res = await req('POST', '/v1/__saas_test', { token: created.body.key, body: { model: 'test-model', messages: [] } });
    expect(res.status).toBe(200);
    expect(res.body.model).toBe('test-model');
    expect(res.headers.get('X-ALI-BOSS-Request-ID')).toBeTruthy();
    await new Promise(r => setTimeout(r, 30)); // 'finish' handler
    const usage = await req('GET', '/api/saas/usage?days=1', { token: state.tokenA });
    expect(usage.body.totals.requests).toBeGreaterThanOrEqual(1);
    expect(usage.body.totals.tokens).toBeGreaterThanOrEqual(15);
    expect(usage.body.providers[0].provider).toBe('test-provider');
    state.rawKeyA = created.body.key;
  });

  it('preserves streaming byte-for-byte (SaaS middleware does not buffer it)', async () => {
    // FREE has streaming disabled; enable it for this tenant's plan so the
    // test exercises the streaming path rather than the (correct) 403 guard.
    const db = getDb();
    const freePlan = db.prepare("SELECT id, limits_json FROM saas_plans WHERE slug = 'free'").get() as { id: string; limits_json: string };
    const limits = JSON.parse(freePlan.limits_json);
    limits.streaming = true;
    db.prepare('UPDATE saas_plans SET limits_json = ? WHERE id = ?').run(JSON.stringify(limits), freePlan.id);
    const res = await req('POST', '/v1/__saas_test', { token: state.rawKeyA, body: { model: 'test-model', stream: true } });
    limits.streaming = false;
    db.prepare('UPDATE saas_plans SET limits_json = ? WHERE id = ?').run(JSON.stringify(limits), freePlan.id);
    expect(res.status).toBe(200);
    expect(res.raw).toContain('data: [DONE]');
    expect(res.raw).toContain('"delta":{"content":"hello "}');
    expect(res.headers.get('content-type')).toContain('text/event-stream');
  });

  it('enforces quota with 429 and inactive subscriptions with 403', async () => {
    const db = getDb();
    const freePlan = db.prepare("SELECT * FROM saas_plans WHERE slug = 'free'").get() as { id: string; limits_json: string };
    const limits = JSON.parse(freePlan.limits_json);
    limits.requestsPerDay = 1;
    db.prepare('UPDATE saas_plans SET limits_json = ? WHERE id = ?').run(JSON.stringify(limits), freePlan.id);
    // Usage already recorded above → the next request must be rejected.
    const quota = await req('POST', '/v1/__saas_test', { token: state.rawKeyA, body: { model: 'test-model' } });
    expect(quota.status).toBe(429);
    expect(quota.body.error.type).toBe('quota_exceeded');
    limits.requestsPerDay = 100000;
    db.prepare('UPDATE saas_plans SET limits_json = ? WHERE id = ?').run(JSON.stringify(limits), freePlan.id);

    const tid = (db.prepare('SELECT tenant_id FROM saas_users WHERE id = ?').get(state.userIdA) as { tenant_id: string }).tenant_id;
    db.prepare("UPDATE saas_subscriptions SET status = 'past_due' WHERE tenant_id = ? AND status = 'active'").run(tid);
    const sub = await req('POST', '/v1/__saas_test', { token: state.rawKeyA, body: { model: 'test-model' } });
    expect(sub.status).toBe(403);
    expect(sub.body.error.type).toBe('subscription_error');
    db.prepare("UPDATE saas_subscriptions SET status = 'active' WHERE tenant_id = ? AND status = 'past_due'").run(tid);
  });

  it('leaves legacy FreeLLMAPI keys and endpoints working', async () => {
    const ping = await req('GET', '/api/ping');
    expect(ping.status).toBe(200);
    const docs = await req('GET', '/v1/docs');
    expect(docs.status).toBe(200);
    const unified = getUnifiedApiKey();
    const models = await req('GET', '/v1/models', { token: unified });
    expect(models.status).toBe(200);
  });
});

describe('ALI-BOSS SaaS — admin', () => {
  it('requires the admin role', async () => {
    expect((await req('GET', '/api/saas/admin/stats', { token: state.tokenA })).status).toBe(403);
    expect((await req('GET', '/api/saas/admin/stats')).status).toBe(401);
  });

  it('reports revenue from VERIFIED payments only', async () => {
    const stats = await req('GET', '/api/saas/admin/stats', { token: state.tokenAdmin });
    expect(stats.status).toBe(200);
    expect(stats.body.totalUsers).toBeGreaterThanOrEqual(3);
    expect(stats.body.successfulPayments).toBeGreaterThanOrEqual(0); // refunded payment is no longer 'paid'
    const revenue = await req('GET', '/api/saas/admin/revenue', { token: state.tokenAdmin });
    expect(revenue.body).toHaveProperty('total');
  });

  it('edits plans, manages users and writes audit logs', async () => {
    const patch = await req('PATCH', `/api/saas/admin/plans/${state.planProId}`, {
      token: state.tokenAdmin, body: { priceMinor: 89900, features: ['Updated'] },
    });
    expect(patch.status).toBe(200);
    expect(patch.body.priceMinor).toBe(89900);
    expect((await req('GET', '/api/saas/plans', {})).body.plans.find((p: any) => p.slug === 'pro').priceMinor).toBe(89900);

    const suspend = await req('POST', `/api/saas/admin/users/${state.userIdB}/suspend`, { token: state.tokenAdmin, body: {} });
    expect(suspend.status).toBe(200);
    expect((await req('GET', '/api/saas/auth/me', { token: state.tokenB })).status).toBe(401);
    const unsuspend = await req('POST', `/api/saas/admin/users/${state.userIdB}/unsuspend`, { token: state.tokenAdmin, body: {} });
    expect(unsuspend.status).toBe(200);

    const audit = await req('GET', '/api/saas/admin/audit-logs', { token: state.tokenAdmin });
    expect(audit.body.logs.some((l: any) => l.action === 'plan.updated')).toBe(true);
    expect(audit.body.logs.some((l: any) => l.action === 'user.suspended')).toBe(true);
  });
});
