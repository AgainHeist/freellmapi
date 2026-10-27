import { getDb } from '../../db/index.js';
import { enqueueEmail } from '../email.js';
import { errors } from '../errors.js';
import { getPlanById, getPlanBySlug, planLimits, publicPlan } from '../plans/service.js';
import type { PaymentRow, PlanLimits, PlanRow, SubscriptionRow, UserRow } from '../types.js';
import { newId, nowMs } from '../util.js';

const FREE_SUB_DURATION_MS = 10 * 365 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const LIVE_STATUSES = ['trial', 'active', 'past_due'] as const;

export function liveSubscription(tenantId: string): SubscriptionRow | undefined {
  return getDb().prepare(`
    SELECT * FROM saas_subscriptions
    WHERE tenant_id = ? AND status IN ('trial','active','past_due')
    ORDER BY created_at DESC LIMIT 1
  `).get(tenantId) as SubscriptionRow | undefined;
}

export function subscriptionById(id: string): SubscriptionRow | undefined {
  return getDb().prepare('SELECT * FROM saas_subscriptions WHERE id = ?').get(id) as SubscriptionRow | undefined;
}

/** Downgrades an expired paid plan back to FREE (creating a fresh active row)
 *  instead of leaving the tenant with no subscription at all. */
function downgradeToFree(tenantId: string, expiredSubId: string, recipient?: string | null): void {
  const db = getDb();
  const free = getPlanBySlug('free');
  const now = nowMs();
  db.transaction(() => {
    db.prepare("UPDATE saas_subscriptions SET status = 'expired', updated_at = ? WHERE id = ?").run(now, expiredSubId);
    if (free && !liveSubscription(tenantId)) {
      db.prepare(`
        INSERT INTO saas_subscriptions
          (id, tenant_id, plan_id, status, start_at, end_at, renewal_at, payment_id, created_at, updated_at)
        VALUES (?, ?, ?, 'active', ?, ?, NULL, NULL, ?, ?)
      `).run(newId('sub'), tenantId, free.id, now, now + FREE_SUB_DURATION_MS, now, now);
    }
  })();
  if (recipient) {
    enqueueEmail(recipient, 'subscription_expired', 'Your ALI-BOSS subscription expired and your workspace moved to the FREE plan.');
  }
}

/** Resolve the subscription, applying expiry lazily. Called on every API
 *  request and dashboard load, so expiry does not depend on a cron running. */
export function resolveSubscription(tenantId: string): { subscription: SubscriptionRow; plan: PlanRow; limits: PlanLimits } {
  let sub = liveSubscription(tenantId);
  if (sub && sub.end_at < nowMs()) {
    const email = getDb().prepare('SELECT email FROM saas_users WHERE tenant_id = ? ORDER BY created_at LIMIT 1')
      .get(tenantId) as { email: string } | undefined;
    downgradeToFree(tenantId, sub.id, email?.email);
    sub = liveSubscription(tenantId);
  }
  if (!sub) {
    // Defensive: a tenant created outside createAccount still gets FREE.
    const free = getPlanBySlug('free');
    if (!free) errors.subscription('no_plans', 'No plans are configured.');
    const now = nowMs();
    getDb().prepare(`
      INSERT INTO saas_subscriptions (id, tenant_id, plan_id, status, start_at, end_at, renewal_at, payment_id, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?, NULL, NULL, ?, ?)
    `).run(newId('sub'), tenantId, free.id, now, now + FREE_SUB_DURATION_MS, now, now);
    sub = liveSubscription(tenantId)!;
  }
  const plan = getPlanById(sub.plan_id);
  if (!plan) errors.subscription('plan_missing', 'Your plan is no longer available. Contact support.');
  return { subscription: sub, plan, limits: planLimits(plan) };
}

export function subscriptionView(sub: SubscriptionRow) {
  const plan = getPlanById(sub.plan_id);
  return {
    id: sub.id,
    status: sub.status,
    plan: plan ? publicPlan(plan) : null,
    startAt: sub.start_at,
    endAt: sub.end_at,
    renewalAt: sub.renewal_at,
    paymentId: sub.payment_id,
    updatedAt: sub.updated_at,
  };
}

/**
 * Activate (or extend) a tenant's paid plan after a VERIFIED payment.
 * Idempotent: keyed on payment.id. Replaying the same webhook finds the
 * subscription already carrying that payment_id and returns it unchanged.
 */
export function activateFromPayment(payment: PaymentRow): SubscriptionRow {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM saas_subscriptions WHERE payment_id = ?').get(payment.id) as SubscriptionRow | undefined;
  if (existing) return existing;

  const plan = getPlanById(payment.plan_id);
  if (!plan) errors.payment('plan_missing', 'Plan for this payment no longer exists.');

  const now = nowMs();
  const cycleMs = Math.max(1, plan.billing_cycle_days) * DAY_MS;
  const current = liveSubscription(payment.tenant_id);

  // Extend a still-live paid subscription from its existing end date rather
  // than from "now", so an early renewal does not steal days from the customer.
  const base = current && current.plan_id !== getPlanBySlug('free')?.id && current.end_at > now
    ? current.end_at
    : now;
  const endAt = base + cycleMs;

  if (current) {
    db.prepare(`
      UPDATE saas_subscriptions
      SET plan_id = ?, status = 'active', start_at = ?, end_at = ?, renewal_at = ?, payment_id = ?, updated_at = ?
      WHERE id = ?
    `).run(plan.id, current.start_at, endAt, endAt, payment.id, now, current.id);
  } else {
    db.prepare(`
      INSERT INTO saas_subscriptions
        (id, tenant_id, plan_id, status, start_at, end_at, renewal_at, payment_id, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
    `).run(newId('sub'), payment.tenant_id, plan.id, now, endAt, endAt, payment.id, now, now);
  }

  const owner = db.prepare('SELECT email FROM saas_users WHERE tenant_id = ? ORDER BY created_at LIMIT 1')
    .get(payment.tenant_id) as { email: string } | undefined;
  if (owner) {
    enqueueEmail(owner.email, 'subscription_activated', `Your ${plan.name} plan is active until ${new Date(endAt).toUTCString()}.`);
  }
  return liveSubscription(payment.tenant_id)!;
}

/** Reverse a paid activation after a verified refund webhook. */
export function revokePaymentActivation(paymentId: string): void {
  const db = getDb();
  const sub = db.prepare('SELECT * FROM saas_subscriptions WHERE payment_id = ?').get(paymentId) as SubscriptionRow | undefined;
  if (!sub) return;
  const now = nowMs();
  db.transaction(() => {
    db.prepare("UPDATE saas_subscriptions SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now, sub.id);
    const free = getPlanBySlug('free');
    if (free && !liveSubscription(sub.tenant_id)) {
      db.prepare(`
        INSERT INTO saas_subscriptions (id, tenant_id, plan_id, status, start_at, end_at, renewal_at, payment_id, created_at, updated_at)
        VALUES (?, ?, ?, 'active', ?, ?, NULL, NULL, ?, ?)
      `).run(newId('sub'), sub.tenant_id, free.id, now, now + FREE_SUB_DURATION_MS, now, now);
    }
  })();
}

/** Cron-style sweep for expiring / expired subscriptions. Cheap enough to run
 *  hourly; the lazy resolveSubscription() above is the authoritative check. */
export function sweepSubscriptions(): { expired: number; expiring: number } {
  const db = getDb();
  const now = nowMs();
  const expired = db.prepare(`
    SELECT s.id, s.tenant_id, (SELECT email FROM saas_users u WHERE u.tenant_id = s.tenant_id ORDER BY created_at LIMIT 1) AS email
    FROM saas_subscriptions s
    WHERE s.status IN ('trial','active','past_due') AND s.end_at < ?
  `).all(now) as { id: string; tenant_id: string; email: string | null }[];
  for (const row of expired) downgradeToFree(row.tenant_id, row.id, row.email);

  const soon = now + 3 * DAY_MS;
  const expiring = db.prepare(`
    SELECT s.id, u.email FROM saas_subscriptions s
    JOIN saas_users u ON u.tenant_id = s.tenant_id
    WHERE s.status = 'active' AND s.end_at BETWEEN ? AND ? AND s.renewal_at IS NOT NULL
  `).all(now, soon) as { id: string; email: string }[];
  // Deduplicated by (plan, day) through the outbox: a sweep must not spam.
  for (const row of expiring.slice(0, 50)) {
    enqueueEmail(row.email, 'subscription_expiring', 'Your ALI-BOSS subscription expires in 3 days. Renew from the Billing page.');
  }
  return { expired: expired.length, expiring: expiring.length };
}

export function adminChangePlan(tenantId: string, planId: string, actor: Pick<UserRow, 'id' | 'email' | 'role'>): SubscriptionRow {
  const plan = getPlanById(planId);
  if (!plan) errors.notFound('Plan');
  const sub = liveSubscription(tenantId);
  const now = nowMs();
  if (sub) {
    getDb().prepare('UPDATE saas_subscriptions SET plan_id = ?, end_at = ?, updated_at = ? WHERE id = ?')
      .run(planId, now + Math.max(1, plan.billing_cycle_days) * DAY_MS, now, sub.id);
  } else {
    getDb().prepare(`
      INSERT INTO saas_subscriptions (id, tenant_id, plan_id, status, start_at, end_at, renewal_at, payment_id, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?, ?, NULL, ?, ?)
    `).run(newId('sub'), tenantId, planId, now, now + Math.max(1, plan.billing_cycle_days) * DAY_MS, null, now, now);
  }
  void actor;
  return liveSubscription(tenantId)!;
}

export function adminSetSubscriptionStatus(tenantId: string, status: 'active' | 'cancelled' | 'suspended' | 'past_due'): SubscriptionRow | undefined {
  const sub = liveSubscription(tenantId);
  if (!sub) return undefined;
  getDb().prepare('UPDATE saas_subscriptions SET status = ?, updated_at = ? WHERE id = ?').run(status, nowMs(), sub.id);
  return subscriptionById(sub.id);
}

export function adminExtendSubscription(tenantId: string, days: number): SubscriptionRow | undefined {
  const sub = liveSubscription(tenantId);
  if (!sub || days <= 0 || days > 3650) return undefined;
  const endAt = Math.max(sub.end_at, nowMs()) + days * DAY_MS;
  getDb().prepare('UPDATE saas_subscriptions SET end_at = ?, renewal_at = ?, updated_at = ? WHERE id = ?')
    .run(endAt, endAt, nowMs(), sub.id);
  return subscriptionById(sub.id);
}
