import { getDb } from '../../db/index.js';
import { audit } from '../audit.js';
import { gatewayName, paymentConfigured, paymentCredentials } from '../config.js';
import { enqueueEmail } from '../email.js';
import { errors } from '../errors.js';
import { getPlanById, getPlanBySlug } from '../plans/service.js';
import { activateFromPayment, revokePaymentActivation, subscriptionView } from '../subscriptions/service.js';
import type { PaymentRow, PlanRow, UserRow } from '../types.js';
import { newId, nowMs, parseJson } from '../util.js';
import { activeGateway, type GatewayPayment } from './gateway.js';

export function getPaymentById(id: string): PaymentRow | undefined {
  return getDb().prepare('SELECT * FROM saas_payments WHERE id = ?').get(id) as PaymentRow | undefined;
}

function paymentByOrderId(orderId: string): PaymentRow | undefined {
  return getDb().prepare('SELECT * FROM saas_payments WHERE order_id = ? OR gateway_order_id = ?').get(orderId, orderId) as PaymentRow | undefined;
}

export function publicPayment(row: PaymentRow) {
  return {
    id: row.id,
    orderId: row.order_id,
    planId: row.plan_id,
    amountMinor: row.amount_minor,
    currency: row.currency,
    status: row.status,
    gateway: row.gateway,
    gatewayPaymentId: row.gateway_payment_id,
    createdAt: row.created_at,
    verifiedAt: row.verified_at,
  };
}

/** Step 1 — create a gateway order and a pending local payment row. */
export async function createCheckout(input: {
  user: UserRow;
  planSlug: string;
  idempotencyKey?: string;
}): Promise<{
  paymentId: string;
  orderId: string;
  amountMinor: number;
  currency: string;
  keyId: string;
  gateway: string;
  planName: string;
}> {
  const plan = getPlanBySlug(input.planSlug);
  if (!plan || !plan.is_active) errors.badRequest('That plan is not available.');
  if (plan.price_minor <= 0) errors.badRequest('The FREE plan does not require payment. It is already active.');
  if (!paymentConfigured()) throw new Error('Payment gateway is not configured on the server.');

  // Retrying the same checkout (double click, flaky network) must not create
  // two orders that could both later activate the subscription.
  if (input.idempotencyKey) {
    const existing = getDb().prepare(
      "SELECT * FROM saas_payments WHERE tenant_id = ? AND status = 'pending' AND metadata_json LIKE ? ORDER BY created_at DESC LIMIT 1",
    ).get(input.user.tenant_id, `%${input.idempotencyKey}%`) as PaymentRow | undefined;
    if (existing && Date.now() - existing.created_at < 10 * 60 * 1000) {
      return {
        paymentId: existing.id, orderId: existing.order_id,
        amountMinor: existing.amount_minor, currency: existing.currency,
        keyId: paymentCredentials().keyId, gateway: existing.gateway, planName: plan.name,
      };
    }
  }

  const gateway = activeGateway();
  const id = newId('pay');
  const receipt = `rcpt_${id}`;
  const order = await gateway.createOrder({
    amountMinor: plan.price_minor,
    currency: plan.currency,
    receipt,
    notes: { tenant_id: input.user.tenant_id, plan_id: plan.id, user_id: input.user.id },
  });

  const now = nowMs();
  getDb().prepare(`
    INSERT INTO saas_payments
      (id, order_id, user_id, tenant_id, plan_id, amount_minor, currency, status, gateway,
       gateway_payment_id, gateway_order_id, gateway_reference, verified_at, metadata_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?, ?, NULL, ?, ?, ?)
  `).run(
    id, order.id, input.user.id, input.user.tenant_id, plan.id, plan.price_minor, plan.currency,
    gateway.name, order.id, order.id,
    JSON.stringify({ receipt, idempotencyKey: input.idempotencyKey ?? null }), now, now,
  );

  return {
    paymentId: id,
    orderId: order.id,
    amountMinor: plan.price_minor,
    currency: plan.currency,
    keyId: paymentCredentials().keyId,
    gateway: gateway.name,
    planName: plan.name,
  };
}

/** Verify a captured payment against the gateway AND our own row. */
function assertPaymentMatches(row: PaymentRow, gatewayPayment: GatewayPayment): void {
  if (gatewayPayment.status !== 'captured' && gatewayPayment.status !== 'authorized') {
    errors.payment('payment_not_captured', `Payment is ${gatewayPayment.status}, not captured.`);
  }
  if (gatewayPayment.orderId !== row.gateway_order_id && gatewayPayment.orderId !== row.order_id) {
    errors.payment('order_mismatch', 'Gateway payment does not belong to this order.');
  }
  if (gatewayPayment.amount !== row.amount_minor) {
    errors.payment('amount_mismatch', 'Gateway payment amount does not match the order.');
  }
  if (gatewayPayment.currency.toUpperCase() !== row.currency.toUpperCase()) {
    errors.payment('currency_mismatch', 'Gateway payment currency does not match the order.');
  }
}

function markPaid(row: PaymentRow, gatewayPaymentId: string): PaymentRow {
  const db = getDb();
  const result = db.prepare(`
    UPDATE saas_payments SET status = 'paid', gateway_payment_id = ?, gateway_reference = ?, verified_at = ?, updated_at = ?
    WHERE id = ? AND status = 'pending'
  `).run(gatewayPaymentId, gatewayPaymentId, nowMs(), nowMs(), row.id);
  if (result.changes === 0) {
    // Already paid (webhook beat the browser verify) — that is fine, but a
    // REFUNDED/FAILED payment must never be re-activated.
    const current = getPaymentById(row.id)!;
    if (current.status !== 'paid') errors.payment('payment_not_payable', `Payment is ${current.status}.`);
    return current;
  }
  const paid = getPaymentById(row.id)!;
  createInvoice(paid);
  return paid;
}

function createInvoice(payment: PaymentRow): void {
  const db = getDb();
  if (db.prepare('SELECT id FROM saas_invoices WHERE payment_id = ?').get(payment.id)) return;
  const d = new Date(payment.created_at);
  const number = `INV-${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}-${payment.id.slice(-8).toUpperCase()}`;
  db.prepare(`
    INSERT INTO saas_invoices (id, payment_id, tenant_id, number, amount_minor, currency, issued_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(newId('inv'), payment.id, payment.tenant_id, number, payment.amount_minor, payment.currency, nowMs());
}

export function fulfillPayment(row: PaymentRow, gatewayPaymentId: string): { subscription: ReturnType<typeof subscriptionView>; payment: ReturnType<typeof publicPayment> } {
  const paid = markPaid(row, gatewayPaymentId);
  const sub = activateFromPayment(paid);
  const plan = getPlanById(paid.plan_id) as PlanRow;
  const owner = getDb().prepare('SELECT email FROM saas_users WHERE id = ?').get(paid.user_id) as { email: string } | undefined;
  if (owner) {
    enqueueEmail(owner.email, 'payment_success', `Payment of ${(paid.amount_minor / 100).toFixed(2)} ${paid.currency} received for the ${plan.name} plan.\nInvoice: see Billing → Payments.`);
  }
  return { subscription: subscriptionView(sub), payment: publicPayment(paid) };
}

/** Step 2 — browser returns from checkout. Signature + gateway re-fetch, and
 *  the tenant is taken from the SESSION, never from the request body. */
export async function verifyCheckout(input: {
  tenantId: string;
  orderId: string;
  paymentId: string;
  signature: string;
  actor?: Pick<UserRow, 'id' | 'email' | 'role'>;
}): Promise<ReturnType<typeof fulfillPayment>> {
  if (!input.orderId || !input.paymentId || !input.signature) errors.badRequest('Missing payment verification fields.');
  const row = paymentByOrderId(input.orderId);
  if (!row || row.tenant_id !== input.tenantId) errors.payment('unknown_order', 'Order not found for this account.');
  if (row.status === 'paid') {
    const sub = activateFromPayment(row);
    return { subscription: subscriptionView(sub), payment: publicPayment(row) };
  }
  if (row.status !== 'pending') errors.payment('payment_not_payable', `Payment is ${row.status}.`);

  const gateway = activeGateway();
  if (!gateway.verifyCheckoutSignature({ orderId: input.orderId, paymentId: input.paymentId, signature: input.signature })) {
    audit({
      actor: input.actor ?? null, action: 'payment.signature_invalid',
      targetType: 'payment', targetId: row.id, metadata: { orderId: input.orderId },
    });
    errors.payment('invalid_signature', 'Payment signature verification failed.');
  }

  // Never trust the browser's "success": re-read the payment from the gateway
  // and compare order id, amount and currency with the pending row.
  const gatewayPayment = await gateway.fetchPayment(input.paymentId);
  assertPaymentMatches(row, gatewayPayment);
  return fulfillPayment(row, gatewayPayment.id);
}

export interface WebhookResult {
  duplicate: boolean;
  processed: boolean;
  eventType: string;
  reason?: string;
}

/**
 * Idempotent webhook ingestion. The raw body and its signature are verified by
 * the route BEFORE this is called; `signatureValid=false` is recorded and
 * rejected without any state change.
 *
 * Duplicate-event protection: UNIQUE(gateway, event_id) → INSERT OR IGNORE.
 * Payment activation is additionally keyed on payment.id, so a webhook with
 * a NEW event id for the SAME payment still cannot create a second
 * subscription.
 */
export function processWebhook(input: {
  gatewayName: string;
  eventId: string;
  eventType: string;
  rawBody: string;
  signatureValid: boolean;
  payload: Record<string, unknown>;
}): WebhookResult {
  const db = getDb();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO saas_webhook_events
      (id, gateway, event_id, event_type, signature_valid, payload_json, status, received_at)
    VALUES (?, ?, ?, ?, ?, ?, 'received', ?)
  `).run(
    newId('whk'), input.gatewayName, input.eventId, input.eventType,
    input.signatureValid ? 1 : 0, input.rawBody, nowMs(),
  );
  if (insert.changes === 0) return { duplicate: true, processed: false, eventType: input.eventType, reason: 'duplicate_event' };

  const eventRowId = db.prepare('SELECT id FROM saas_webhook_events WHERE gateway = ? AND event_id = ?')
    .get(input.gatewayName, input.eventId) as { id: string };

  const finish = (status: 'processed' | 'ignored' | 'failed', reason?: string): WebhookResult => {
    db.prepare('UPDATE saas_webhook_events SET status = ?, processed_at = ?, error = ? WHERE id = ?')
      .run(status, nowMs(), reason ?? null, eventRowId.id);
    return {
      duplicate: false,
      processed: status === 'processed',
      eventType: input.eventType,
      reason,
    };
  };

  if (!input.signatureValid) return finish('failed', 'invalid_signature');

  try {
    const nested = (input.payload.payload ?? {}) as Record<string, unknown>;
    const type = input.eventType.toLowerCase();

    if (type.includes('payment.failed')) {
      const entity = (nested.payment as { entity?: Record<string, unknown> } | undefined)?.entity ?? {};
      const orderId = String(entity.order_id ?? '');
      const row = orderId ? paymentByOrderId(orderId) : undefined;
      if (row && row.status === 'pending') {
        db.prepare("UPDATE saas_payments SET status = 'failed', updated_at = ? WHERE id = ?").run(nowMs(), row.id);
        const email = db.prepare('SELECT email FROM saas_users WHERE id = ?').get(row.user_id) as { email: string } | undefined;
        if (email) enqueueEmail(email.email, 'payment_failed', 'Your ALI-BOSS payment could not be completed. No subscription was activated.');
      }
      return finish('processed');
    }

    if (type.includes('refund')) {
      const entity = (nested.refund as { entity?: Record<string, unknown> } | undefined)?.entity ?? {};
      const gatewayPaymentId = String(entity.payment_id ?? '');
      const row = gatewayPaymentId
        ? db.prepare('SELECT * FROM saas_payments WHERE gateway_payment_id = ?').get(gatewayPaymentId) as PaymentRow | undefined
        : undefined;
      if (row) recordRefund(row, Number(entity.amount ?? row.amount_minor), String(entity.id ?? ''), 'gateway_webhook');
      return finish(row ? 'processed' : 'ignored', row ? undefined : 'unknown_payment');
    }

    // payment.captured / order.paid (and the generic test event)
    const entity = (nested.payment as { entity?: Record<string, unknown> } | undefined)?.entity
      ?? (nested.order as { entity?: Record<string, unknown> } | undefined)?.entity
      ?? (input.payload as Record<string, unknown>);
    const orderId = String(entity.order_id ?? (input.payload as Record<string, unknown>).order_id ?? '');
    const paymentId = String(entity.id ?? (input.payload as Record<string, unknown>).payment_id ?? '');
    const row = orderId ? paymentByOrderId(orderId) : undefined;
    if (!row) return finish('ignored', 'unknown_order');

    // Amount/order/currency must match what WE recorded — a valid signature
    // from a compromised dashboard key must still not mint a subscription for
    // a ₹0 order.
    const amount = Number(entity.amount ?? row.amount_minor);
    const currency = String(entity.currency ?? row.currency);
    if (amount !== row.amount_minor || currency.toUpperCase() !== row.currency.toUpperCase()) {
      return finish('failed', 'webhook_amount_mismatch');
    }
    if (entity.status && !['captured', 'authorized', 'paid'].includes(String(entity.status))) {
      return finish('ignored', `payment_status_${entity.status}`);
    }
    if (row.status === 'refunded') return finish('ignored', 'payment_refunded');

    fulfillPayment(row, paymentId || row.gateway_payment_id || `wh_${input.eventId}`);
    return finish('processed');
  } catch (err) {
    return finish('failed', String((err as Error).message ?? err).slice(0, 300));
  }
}

export function recordRefund(row: PaymentRow, amountMinor: number, gatewayRefundId: string, reason: string): void {
  const db = getDb();
  if (db.prepare('SELECT id FROM saas_refunds WHERE payment_id = ? AND gateway_refund_id = ?').get(row.id, gatewayRefundId)) return;
  db.transaction(() => {
    db.prepare(`
      INSERT INTO saas_refunds (id, payment_id, amount_minor, gateway_refund_id, status, reason, created_at)
      VALUES (?, ?, ?, ?, 'completed', ?, ?)
    `).run(newId('rfnd'), row.id, amountMinor, gatewayRefundId, reason, nowMs());
    db.prepare("UPDATE saas_payments SET status = 'refunded', updated_at = ? WHERE id = ?").run(nowMs(), row.id);
  })();
  revokePaymentActivation(row.id);
  const email = db.prepare('SELECT email FROM saas_users WHERE id = ?').get(row.user_id) as { email: string } | undefined;
  if (email) enqueueEmail(email.email, 'refund', `A refund of ${(amountMinor / 100).toFixed(2)} ${row.currency} has been processed.`);
}

/** Admin-initiated refund: call the gateway, then apply the same local path as
 *  a refund webhook. */
export async function adminRefund(paymentId: string, actor: Pick<UserRow, 'id' | 'email' | 'role'>, reason = 'admin_request'): Promise<PaymentRow> {
  const row = getPaymentById(paymentId);
  if (!row) errors.notFound('Payment');
  if (row.status !== 'paid') errors.payment('not_refundable', 'Only paid payments can be refunded.');
  if (!row.gateway_payment_id) errors.payment('not_refundable', 'This payment has no gateway reference.');
  const refund = await activeGateway().refund(row.gateway_payment_id, row.amount_minor, reason);
  recordRefund(row, refund.amount, refund.id, reason);
  audit({ actor, action: 'payment.refund', targetType: 'payment', targetId: row.id, metadata: { amountMinor: row.amount_minor, reason } });
  return getPaymentById(paymentId)!;
}

export function listTenantPayments(tenantId: string, limit = 50): PaymentRow[] {
  return getDb().prepare('SELECT * FROM saas_payments WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(tenantId, Math.min(Math.max(1, limit), 200)) as PaymentRow[];
}

export function revenueSummary(): { today: number; week: number; month: number; total: number; successful: number; pending: number } {
  const db = getDb();
  const now = nowMs();
  const dayStart = now - 24 * 60 * 60 * 1000;
  const weekStart = now - 7 * 24 * 60 * 60 * 1000;
  const d = new Date(now);
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const sum = (from: number) => (db.prepare(
    "SELECT COALESCE(SUM(amount_minor),0) AS total FROM saas_payments WHERE status = 'paid' AND verified_at >= ?",
  ).get(from) as { total: number }).total;
  const count = (status: string) => (db.prepare('SELECT COUNT(*) AS c FROM saas_payments WHERE status = ?').get(status) as { c: number }).c;
  return { today: sum(dayStart), week: sum(weekStart), month: sum(monthStart), total: sum(0), successful: count('paid'), pending: count('pending') };
}

export function paymentMeta(row: PaymentRow): Record<string, unknown> {
  return parseJson<Record<string, unknown>>(row.metadata_json, {});
}

export function gatewayLabel(): string {
  return gatewayName();
}
