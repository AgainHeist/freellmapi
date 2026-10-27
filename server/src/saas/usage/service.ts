import { getDb } from '../../db/index.js';
import { errors } from '../errors.js';
import type { PlanLimits, UsageRecordInput } from '../types.js';
import { newId, nowMs, startOfUtcDay, startOfUtcMonth } from '../util.js';

export interface QuotaSnapshot {
  requestsToday: number;
  tokensToday: number;
  requestsMonth: number;
  tokensMonth: number;
  requestsDayLimit: number;
  tokensDayLimit: number;
  requestsMonthLimit: number;
  tokensMonthLimit: number;
  remainingDayPercent: number;
}

export function recordUsage(input: UsageRecordInput): void {
  const inputTokens = Math.max(0, Math.trunc(input.inputTokens ?? 0));
  const outputTokens = Math.max(0, Math.trunc(input.outputTokens ?? 0));
  getDb().prepare(`
    INSERT INTO saas_usage_records
      (id, tenant_id, user_id, api_key_id, request_id, endpoint, model, provider,
       input_tokens, output_tokens, total_tokens, latency_ms, status, error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    newId('use'), input.tenantId, input.userId ?? null, input.apiKeyId ?? null, input.requestId ?? null,
    input.endpoint, input.model ?? null, input.provider ?? null,
    inputTokens, outputTokens, inputTokens + outputTokens,
    Math.max(0, Math.trunc(input.latencyMs ?? 0)), input.status, input.error?.slice(0, 400) ?? null, nowMs(),
  );
}

function totals(tenantId: string, since: number): { requests: number; tokens: number } {
  const row = getDb().prepare(`
    SELECT COUNT(*) AS requests, COALESCE(SUM(total_tokens),0) AS tokens
    FROM saas_usage_records WHERE tenant_id = ? AND created_at >= ?
  `).get(tenantId, since) as { requests: number; tokens: number };
  return { requests: Number(row.requests), tokens: Number(row.tokens) };
}

export function quotaSnapshot(tenantId: string, limits: PlanLimits): QuotaSnapshot {
  const day = totals(tenantId, startOfUtcDay());
  const month = totals(tenantId, startOfUtcMonth());
  const dayPct = limits.requestsPerDay > 0
    ? Math.max(0, Math.min(100, Math.round((1 - day.requests / limits.requestsPerDay) * 100)))
    : 100;
  return {
    requestsToday: day.requests,
    tokensToday: day.tokens,
    requestsMonth: month.requests,
    tokensMonth: month.tokens,
    requestsDayLimit: limits.requestsPerDay,
    tokensDayLimit: limits.tokensPerDay,
    requestsMonthLimit: limits.requestsPerMonth,
    tokensMonthLimit: limits.tokensPerMonth,
    remainingDayPercent: dayPct,
  };
}

/** Called BEFORE the request is forwarded to the FreeLLMAPI router. */
export function enforceQuota(tenantId: string, limits: PlanLimits): QuotaSnapshot {
  const snap = quotaSnapshot(tenantId, limits);
  if (snap.requestsToday >= limits.requestsPerDay) errors.quota('daily_request_limit', 'Daily request quota reached for your plan.');
  if (snap.requestsMonth >= limits.requestsPerMonth) errors.quota('monthly_request_limit', 'Monthly request quota reached for your plan.');
  if (snap.tokensToday >= limits.tokensPerDay) errors.quota('daily_token_limit', 'Daily token quota reached for your plan.');
  if (snap.tokensMonth >= limits.tokensPerMonth) errors.quota('monthly_token_limit', 'Monthly token quota reached for your plan.');
  return snap;
}

/** Fixed 60-second window counters in the DB. A counter row is unique per
 *  (scope, window), so concurrent workers increment the same row atomically. */
export function enforceRateLimit(tenantId: string, limits: PlanLimits): void {
  const db = getDb();
  const windowStart = Math.floor(nowMs() / 60000) * 60000;
  const key = `rpm:${tenantId}`;
  db.prepare(`
    INSERT INTO saas_rate_limits (scope_key, window_start, count, tokens) VALUES (?, ?, 1, 0)
    ON CONFLICT(scope_key, window_start) DO UPDATE SET count = count + 1
  `).run(key, windowStart);
  const row = db.prepare('SELECT count FROM saas_rate_limits WHERE scope_key = ? AND window_start = ?')
    .get(key, windowStart) as { count: number };
  if (row.count > limits.requestsPerMinute) errors.rateLimit(`Rate limit exceeded: ${limits.requestsPerMinute} requests/minute on your plan.`);

  // TPM uses recorded token usage over the trailing 60 seconds, so a single
  // huge response cannot be replayed inside one window without counting.
  const tokens = (db.prepare(`
    SELECT COALESCE(SUM(total_tokens),0) AS t FROM saas_usage_records
    WHERE tenant_id = ? AND created_at >= ?
  `).get(tenantId, nowMs() - 60000) as { t: number }).t;
  if (tokens >= limits.tokensPerMinute) errors.rateLimit(`Token rate limit exceeded: ${limits.tokensPerMinute} tokens/minute on your plan.`);

  // Opportunistic cleanup of old windows (one cheap DELETE per request).
  db.prepare('DELETE FROM saas_rate_limits WHERE window_start < ?').run(windowStart - 5 * 60000);
}

export interface AnalyticsResult {
  days: number;
  totals: { requests: number; tokens: number; errors: number; avgLatencyMs: number; errorRate: number };
  daily: { day: string; requests: number; tokens: number; errors: number; latency: number }[];
  models: { model: string; requests: number; tokens: number }[];
  providers: { provider: string; requests: number; tokens: number }[];
  recent: {
    id: string; endpoint: string; model: string | null; provider: string | null;
    totalTokens: number; latencyMs: number; status: string; error: string | null; createdAt: number;
  }[];
}

export function tenantAnalytics(tenantId: string, days = 30): AnalyticsResult {
  const db = getDb();
  const span = Math.min(Math.max(1, days), 365);
  const since = nowMs() - span * 24 * 60 * 60 * 1000;
  const total = db.prepare(`
    SELECT COUNT(*) AS requests, COALESCE(SUM(total_tokens),0) AS tokens,
           COALESCE(AVG(latency_ms),0) AS latency,
           COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END),0) AS errors
    FROM saas_usage_records WHERE tenant_id = ? AND created_at >= ?
  `).get(tenantId, since) as { requests: number; tokens: number; latency: number; errors: number };

  const dailyRows = db.prepare(`
    SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day,
           COUNT(*) AS requests, COALESCE(SUM(total_tokens),0) AS tokens,
           COALESCE(AVG(latency_ms),0) AS latency,
           COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END),0) AS errors
    FROM saas_usage_records WHERE tenant_id = ? AND created_at >= ?
    GROUP BY day ORDER BY day
  `).all(tenantId, since) as { day: string; requests: number; tokens: number; latency: number; errors: number }[];

  const models = db.prepare(`
    SELECT COALESCE(model,'unknown') AS model, COUNT(*) AS requests, COALESCE(SUM(total_tokens),0) AS tokens
    FROM saas_usage_records WHERE tenant_id = ? AND created_at >= ?
    GROUP BY model ORDER BY requests DESC LIMIT 10
  `).all(tenantId, since) as { model: string; requests: number; tokens: number }[];

  const providers = db.prepare(`
    SELECT COALESCE(provider,'unknown') AS provider, COUNT(*) AS requests, COALESCE(SUM(total_tokens),0) AS tokens
    FROM saas_usage_records WHERE tenant_id = ? AND created_at >= ?
    GROUP BY provider ORDER BY requests DESC LIMIT 10
  `).all(tenantId, since) as { provider: string; requests: number; tokens: number }[];

  const recent = db.prepare(`
    SELECT id, endpoint, model, provider, total_tokens, latency_ms, status, error, created_at
    FROM saas_usage_records WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 25
  `).all(tenantId) as {
    id: string; endpoint: string; model: string | null; provider: string | null;
    total_tokens: number; latency_ms: number; status: string; error: string | null; created_at: number;
  }[];

  return {
    days: span,
    totals: {
      requests: Number(total.requests),
      tokens: Number(total.tokens),
      errors: Number(total.errors),
      avgLatencyMs: Math.round(Number(total.latency)),
      errorRate: Number(total.requests) ? Number(total.errors) / Number(total.requests) : 0,
    },
    daily: dailyRows.map(r => ({ ...r, latency: Math.round(Number(r.latency)) })),
    models, providers,
    recent: recent.map(r => ({
      id: r.id, endpoint: r.endpoint, model: r.model, provider: r.provider,
      totalTokens: r.total_tokens, latencyMs: r.latency_ms, status: r.status,
      error: r.error, createdAt: r.created_at,
    })),
  };
}

export function globalUsageStats(): { requests: number; tokens: number; errors: number } {
  const row = getDb().prepare(`
    SELECT COUNT(*) AS requests, COALESCE(SUM(total_tokens),0) AS tokens,
           COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END),0) AS errors
    FROM saas_usage_records
  `).get() as { requests: number; tokens: number; errors: number };
  return { requests: Number(row.requests), tokens: Number(row.tokens), errors: Number(row.errors) };
}
