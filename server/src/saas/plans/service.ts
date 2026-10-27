import { getDb } from '../../db/index.js';
import { errors } from '../errors.js';
import type { PlanLimits, PlanRow } from '../types.js';
import { newId, nowMs, parseJson } from '../util.js';

export const DEFAULT_LIMITS: PlanLimits = {
  requestsPerMinute: 3,
  requestsPerDay: 50,
  requestsPerMonth: 1000,
  tokensPerMinute: 20000,
  tokensPerDay: 50000,
  tokensPerMonth: 500000,
  maxModels: 10,
  streaming: false,
  embeddings: false,
  providerAccess: ['free'],
  support: 'community',
};

export function getPlanById(id: string): PlanRow | undefined {
  return getDb().prepare('SELECT * FROM saas_plans WHERE id = ?').get(id) as PlanRow | undefined;
}

export function getPlanBySlug(slug: string): PlanRow | undefined {
  return getDb().prepare('SELECT * FROM saas_plans WHERE slug = ?').get(slug) as PlanRow | undefined;
}

export function listPlans(includeInactive = false): PlanRow[] {
  const sql = includeInactive
    ? 'SELECT * FROM saas_plans ORDER BY sort_order, price_minor'
    : 'SELECT * FROM saas_plans WHERE is_active = 1 ORDER BY sort_order, price_minor';
  return getDb().prepare(sql).all() as PlanRow[];
}

export function planLimits(plan: PlanRow): PlanLimits {
  return { ...DEFAULT_LIMITS, ...parseJson<Partial<PlanLimits>>(plan.limits_json, {}) };
}

export interface PublicPlan {
  id: string;
  slug: string;
  name: string;
  priceMinor: number;
  currency: string;
  billingCycleDays: number;
  limits: PlanLimits;
  features: string[];
  isActive: boolean;
}

export function publicPlan(plan: PlanRow): PublicPlan {
  return {
    id: plan.id,
    slug: plan.slug,
    name: plan.name,
    priceMinor: plan.price_minor,
    currency: plan.currency,
    billingCycleDays: plan.billing_cycle_days,
    limits: planLimits(plan),
    features: parseJson<string[]>(plan.features_json, []),
    isActive: Boolean(plan.is_active),
  };
}

const NUMERIC_LIMIT_KEYS: (keyof PlanLimits)[] = [
  'requestsPerMinute', 'requestsPerDay', 'requestsPerMonth',
  'tokensPerMinute', 'tokensPerDay', 'tokensPerMonth', 'maxModels',
];

/** Admin edits. Prices are never hard-coded in the client: the pricing page
 *  renders whatever this table returns. */
export function updatePlan(id: string, patch: {
  name?: string;
  priceMinor?: number;
  currency?: string;
  billingCycleDays?: number;
  limits?: Partial<PlanLimits>;
  features?: string[];
  isActive?: boolean;
}): PlanRow {
  const plan = getPlanById(id);
  if (!plan) errors.notFound('Plan');

  const limits = { ...planLimits(plan) };
  if (patch.limits) {
    for (const key of NUMERIC_LIMIT_KEYS) {
      const value = patch.limits[key];
      if (value !== undefined) {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
          errors.badRequest(`${key} must be a non-negative number.`);
        }
        (limits as unknown as Record<string, unknown>)[key] = value;
      }
    }
    for (const key of ['streaming', 'embeddings'] as const) {
      if (patch.limits[key] !== undefined) limits[key] = Boolean(patch.limits[key]);
    }
    if (patch.limits.providerAccess !== undefined) {
      if (!Array.isArray(patch.limits.providerAccess)) errors.badRequest('providerAccess must be an array.');
      limits.providerAccess = patch.limits.providerAccess.map(String);
    }
    if (patch.limits.support !== undefined) limits.support = String(patch.limits.support);
  }

  if (patch.priceMinor !== undefined && (!Number.isInteger(patch.priceMinor) || patch.priceMinor < 0)) {
    errors.badRequest('priceMinor must be a non-negative integer (minor currency units).');
  }

  getDb().prepare(`
    UPDATE saas_plans SET name = ?, price_minor = ?, currency = ?, billing_cycle_days = ?,
      limits_json = ?, features_json = ?, is_active = ?, updated_at = ? WHERE id = ?
  `).run(
    patch.name ?? plan.name,
    patch.priceMinor ?? plan.price_minor,
    patch.currency ?? plan.currency,
    patch.billingCycleDays ?? plan.billing_cycle_days,
    JSON.stringify(limits),
    patch.features ? JSON.stringify(patch.features) : plan.features_json,
    patch.isActive === undefined ? plan.is_active : (patch.isActive ? 1 : 0),
    nowMs(), id,
  );
  return getPlanById(id)!;
}

export function createPlan(input: {
  slug: string; name: string; priceMinor: number; currency?: string;
  billingCycleDays?: number; limits?: Partial<PlanLimits>; features?: string[];
}): PlanRow {
  const slug = input.slug.trim().toLowerCase();
  if (!/^[a-z0-9_-]{2,32}$/.test(slug)) errors.badRequest('Plan slug must be 2-32 lowercase letters, digits, - or _.');
  if (getPlanBySlug(slug)) errors.badRequest('A plan with that slug already exists.');
  const id = newId('plan');
  const now = nowMs();
  getDb().prepare(`
    INSERT INTO saas_plans
      (id, slug, name, price_minor, currency, billing_cycle_days, limits_json, features_json, is_active, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 99, ?, ?)
  `).run(
    id, slug, input.name, input.priceMinor, input.currency ?? 'INR', input.billingCycleDays ?? 30,
    JSON.stringify({ ...DEFAULT_LIMITS, ...(input.limits ?? {}) }),
    JSON.stringify(input.features ?? []), now, now,
  );
  return getPlanById(id)!;
}
