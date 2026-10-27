// Migration: ALI-BOSS SaaS layer — tenants, billing, API gateway (#saas-core)
// Created: 2026-10-27
//
// DOWN: reversible (drops every saas_* table). Never touches the FreeLLMAPI
// core tables, so running it (or rolling it back) cannot lose router state.
//
// Why the `saas_` prefix: FreeLLMAPI already owns `users`, `sessions`,
// `api_keys`, `requests`, `rate_limit_usage` and `settings` for the local
// single-operator dashboard. A public multi-tenant SaaS needs its own
// identity + billing namespace, and reusing those names would silently bind
// customer accounts to the operator's dashboard session. The two systems
// coexist: the SaaS layer is an additive shell around the existing router.
//
// Portability: ids are TEXT UUIDs, timestamps are INTEGER epoch
// milliseconds, JSON is stored as TEXT, and booleans are 0/1. Every statement
// below is valid SQLite and needs only mechanical changes (SERIAL/uuid,
// timestamptz, jsonb) to run on PostgreSQL — see docs/SAAS.md.

import type { Db } from '../types.js';

const PLAN_SEEDS: { slug: string; name: string; price: number; limits: string; features: string; sort: number }[] = [
  {
    slug: 'free', name: 'FREE', price: 0, sort: 0,
    limits: JSON.stringify({
      requestsPerMinute: 3, requestsPerDay: 50, requestsPerMonth: 1000,
      tokensPerMinute: 20000, tokensPerDay: 50000, tokensPerMonth: 500000,
      maxModels: 10, streaming: false, embeddings: false, providerAccess: ['free'], support: 'community',
    }),
    features: JSON.stringify(['50 requests/day', '500K tokens/month', 'Community support']),
  },
  {
    slug: 'starter', name: 'STARTER', price: 29900, sort: 1,
    limits: JSON.stringify({
      requestsPerMinute: 20, requestsPerDay: 1000, requestsPerMonth: 20000,
      tokensPerMinute: 100000, tokensPerDay: 1000000, tokensPerMonth: 10000000,
      maxModels: 100, streaming: true, embeddings: true, providerAccess: ['free'], support: 'email',
    }),
    features: JSON.stringify(['1,000 requests/day', '10M tokens/month', 'Streaming + embeddings', 'Email support']),
  },
  {
    slug: 'pro', name: 'PRO', price: 79900, sort: 2,
    limits: JSON.stringify({
      requestsPerMinute: 60, requestsPerDay: 5000, requestsPerMonth: 100000,
      tokensPerMinute: 400000, tokensPerDay: 5000000, tokensPerMonth: 50000000,
      maxModels: 635, streaming: true, embeddings: true, providerAccess: ['free', 'custom'], support: 'priority',
    }),
    features: JSON.stringify(['5,000 requests/day', '50M tokens/month', 'All models + custom providers', 'Priority support']),
  },
  {
    slug: 'business', name: 'BUSINESS', price: 199900, sort: 3,
    limits: JSON.stringify({
      requestsPerMinute: 300, requestsPerDay: 25000, requestsPerMonth: 500000,
      tokensPerMinute: 2000000, tokensPerDay: 25000000, tokensPerMonth: 250000000,
      maxModels: 635, streaming: true, embeddings: true, providerAccess: ['free', 'custom'], support: 'dedicated',
    }),
    features: JSON.stringify(['25,000 requests/day', '250M tokens/month', 'Highest rate limits', 'Dedicated support']),
  },
];

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS saas_tenants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_user_id TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
      settings_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS saas_users (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES saas_tenants(id) ON DELETE CASCADE,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
      email_verified INTEGER NOT NULL DEFAULT 0,
      referral_code TEXT,
      referred_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_saas_users_tenant ON saas_users(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_saas_users_email ON saas_users(email);

    CREATE TABLE IF NOT EXISTS saas_sessions (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL REFERENCES saas_users(id) ON DELETE CASCADE,
      tenant_id TEXT NOT NULL REFERENCES saas_tenants(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      ip TEXT,
      user_agent TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_saas_sessions_user ON saas_sessions(user_id);

    CREATE TABLE IF NOT EXISTS saas_plans (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      price_minor INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'INR',
      billing_cycle_days INTEGER NOT NULL DEFAULT 30,
      limits_json TEXT NOT NULL,
      features_json TEXT NOT NULL DEFAULT '[]',
      is_active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS saas_subscriptions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES saas_tenants(id) ON DELETE CASCADE,
      plan_id TEXT NOT NULL REFERENCES saas_plans(id),
      status TEXT NOT NULL CHECK (status IN ('trial','active','past_due','expired','cancelled','suspended')),
      start_at INTEGER NOT NULL,
      end_at INTEGER NOT NULL,
      renewal_at INTEGER,
      payment_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_saas_subscriptions_tenant ON saas_subscriptions(tenant_id, status);
    -- One live subscription per tenant. Makes webhook replay / double checkout
    -- a constraint violation rather than a duplicate active row.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_saas_one_live_sub
      ON saas_subscriptions(tenant_id) WHERE status IN ('trial','active','past_due');

    CREATE TABLE IF NOT EXISTS saas_payments (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL REFERENCES saas_users(id),
      tenant_id TEXT NOT NULL REFERENCES saas_tenants(id) ON DELETE CASCADE,
      plan_id TEXT NOT NULL REFERENCES saas_plans(id),
      amount_minor INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'INR',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','refunded','cancelled')),
      gateway TEXT NOT NULL DEFAULT 'razorpay',
      gateway_payment_id TEXT,
      gateway_order_id TEXT,
      gateway_reference TEXT,
      verified_at INTEGER,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_saas_payments_tenant ON saas_payments(tenant_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_saas_payments_status ON saas_payments(status);

    CREATE TABLE IF NOT EXISTS saas_api_keys (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES saas_tenants(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES saas_users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      prefix TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      secret_enc TEXT NOT NULL,
      secret_iv TEXT NOT NULL,
      secret_tag TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
      last_used_at INTEGER,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_saas_api_keys_tenant ON saas_api_keys(tenant_id, status);

    CREATE TABLE IF NOT EXISTS saas_provider_keys (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES saas_tenants(id) ON DELETE CASCADE,
      platform TEXT NOT NULL,
      label TEXT NOT NULL,
      secret_enc TEXT NOT NULL,
      secret_iv TEXT NOT NULL,
      secret_tag TEXT NOT NULL,
      masked TEXT NOT NULL,
      base_url TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_saas_provider_keys_tenant ON saas_provider_keys(tenant_id);

    CREATE TABLE IF NOT EXISTS saas_usage_records (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES saas_tenants(id) ON DELETE CASCADE,
      user_id TEXT,
      api_key_id TEXT,
      request_id TEXT,
      endpoint TEXT NOT NULL,
      model TEXT,
      provider TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      error TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_saas_usage_tenant_time ON saas_usage_records(tenant_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_saas_usage_model ON saas_usage_records(tenant_id, model);

    CREATE TABLE IF NOT EXISTS saas_webhook_events (
      id TEXT PRIMARY KEY,
      gateway TEXT NOT NULL,
      event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      signature_valid INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('received','processed','ignored','failed')),
      error TEXT,
      received_at INTEGER NOT NULL,
      processed_at INTEGER,
      UNIQUE(gateway, event_id)
    );
    CREATE INDEX IF NOT EXISTS idx_saas_webhook_received ON saas_webhook_events(received_at);

    CREATE TABLE IF NOT EXISTS saas_audit_logs (
      id TEXT PRIMARY KEY,
      actor_user_id TEXT,
      actor_email TEXT,
      actor_role TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      ip TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_saas_audit_created ON saas_audit_logs(created_at);

    CREATE TABLE IF NOT EXISTS saas_password_resets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES saas_users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS saas_email_verifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES saas_users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS saas_email_outbox (
      id TEXT PRIMARY KEY,
      to_email TEXT NOT NULL,
      template TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed')),
      created_at INTEGER NOT NULL,
      sent_at INTEGER,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_saas_email_outbox_status ON saas_email_outbox(status, created_at);

    CREATE TABLE IF NOT EXISTS saas_refunds (
      id TEXT PRIMARY KEY,
      payment_id TEXT NOT NULL REFERENCES saas_payments(id),
      amount_minor INTEGER NOT NULL,
      gateway_refund_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending','completed','failed')),
      reason TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_saas_refunds_payment ON saas_refunds(payment_id);

    CREATE TABLE IF NOT EXISTS saas_invoices (
      id TEXT PRIMARY KEY,
      payment_id TEXT NOT NULL REFERENCES saas_payments(id),
      tenant_id TEXT NOT NULL REFERENCES saas_tenants(id) ON DELETE CASCADE,
      number TEXT NOT NULL UNIQUE,
      amount_minor INTEGER NOT NULL,
      currency TEXT NOT NULL,
      issued_at INTEGER NOT NULL
    );

    -- DB-backed sliding-window counters survive restarts and work across
    -- multiple Node workers (unlike the in-memory dashboard login throttle).
    CREATE TABLE IF NOT EXISTS saas_rate_limits (
      scope_key TEXT NOT NULL,
      window_start INTEGER NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (scope_key, window_start)
    );
  `);

  const now = Date.now();
  const insertPlan = db.prepare(`
    INSERT OR IGNORE INTO saas_plans
      (id, slug, name, price_minor, currency, billing_cycle_days, limits_json, features_json, is_active, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'INR', 30, ?, ?, 1, ?, ?, ?)
  `);
  for (const plan of PLAN_SEEDS) {
    insertPlan.run(
      `plan_${plan.slug}`, plan.slug, plan.name, plan.price,
      plan.limits, plan.features, plan.sort, now, now,
    );
  }
}

export function down(db: Db): void {
  db.exec(`
    DROP TABLE IF EXISTS saas_rate_limits;
    DROP TABLE IF EXISTS saas_invoices;
    DROP TABLE IF EXISTS saas_refunds;
    DROP TABLE IF EXISTS saas_email_outbox;
    DROP TABLE IF EXISTS saas_email_verifications;
    DROP TABLE IF EXISTS saas_password_resets;
    DROP TABLE IF EXISTS saas_audit_logs;
    DROP TABLE IF EXISTS saas_webhook_events;
    DROP TABLE IF EXISTS saas_usage_records;
    DROP TABLE IF EXISTS saas_provider_keys;
    DROP TABLE IF EXISTS saas_api_keys;
    DROP TABLE IF EXISTS saas_payments;
    DROP TABLE IF EXISTS saas_subscriptions;
    DROP TABLE IF EXISTS saas_plans;
    DROP TABLE IF EXISTS saas_sessions;
    DROP TABLE IF EXISTS saas_users;
    DROP TABLE IF EXISTS saas_tenants;
  `);
}
