# ALI-BOSS SaaS layer

Additive, multi-tenant business layer on top of the **existing FreeLLMAPI router**.
The router was not rewritten: `/v1/chat/completions`, `/v1/responses`, `/v1/messages`,
`/v1/embeddings`, `/v1/models`, `/v1beta/*`, streaming, tool calling, fallback and
provider routing still run the original code. The SaaS layer is a shell in front of
them plus a billing/identity database beside them.

```
Browser ──► ALI-BOSS SPA (React, dark/red)
               │  /, /pricing, /docs, /signup …      public
               │  /dashboard/*                        customer (session)
               │  /admin                             admin (role)
               │  /console/*                         ORIGINAL FreeLLMAPI dashboard
               ▼
Express app (server/src/app.ts)
   ├── /api/webhooks/payment   raw body + HMAC verification (mounted BEFORE express.json)
   ├── /api/saas/*             auth · tenancy · plans · billing · usage · admin
   ├── /v1/docs, /v1/providers …  original public docs
   ├── saasGateway()  ── API key → tenant → subscription → quota → rate limit → usage
   └── ORIGINAL /v1, /v1beta, /mcp routers  ──► providers
```

All SaaS code lives in `server/src/saas/` and `client/src/saas/`. Core files touched:
`server/src/app.ts` (mounts), `server/src/index.ts` (bootstrap), one migration in
`server/src/db/migrations/`, `server/src/db/migrate/defaults.ts` (registration),
`server/src/services/backups.ts` (credential-safe dump policy),
`server/src/db/index.ts` (optional driver override), `client/src/main.tsx` and
`client/src/App.tsx` (SPA split and `/console` basename).

---

## 1. Quick start (local, no real money)

```bash
npm ci
npm run db:migration:up          # applies all migrations incl. 20261027_000001_saas_core
cp .env.example .env             # then set the variables below

# Minimal working .env for a sandbox (Node 22.13+):
SAAS_ENABLED=1
PAYMENT_GATEWAY=mock
PAYMENT_WEBHOOK_SECRET=local-dev-secret
SESSION_SECRET=replace-with-a-long-random-string
ENCRYPTION_KEY=<64 hex chars>
FREEAPI_DB_DRIVER=node-sqlite    # only if better-sqlite3 cannot be built
SAAS_ADMIN_EMAIL=admin@example.com
SAAS_ADMIN_PASSWORD=a-very-long-password

npm run dev                     # http://localhost:5173 (Vite) → :3001 (API)
```

- Public site: `http://localhost:5173/`
- Signup: `/signup` → `/dashboard`
- Admin: `/admin` (sign in as `SAAS_ADMIN_EMAIL`)
- Original operator console: `/console` (unchanged FreeLLMAPI dashboard)
- Create admin manually instead of env: `npm run saas:admin -- admin@example.com a-very-long-password`

In `PAYMENT_GATEWAY=mock` mode, Billing → Choose plan opens a **Sandbox payment**
dialog. "Simulate successful payment" sends a correctly HMAC-signed, gateway-shaped
webhook through the **real** `processWebhook()` path (signature verification,
dedup, amount/order match, subscription activation). No secret is exposed to the
browser and no verification step is skipped.

## 2. Environment variables

See the **ALI-BOSS SaaS layer** section at the bottom of `.env.example`. Summary:

| Variable | Purpose |
| --- | --- |
| `SAAS_ENABLED=1` | Enable /v1 gateway, bootstrap admin, hourly sweeps |
| `SAAS_REQUIRE_KEYS=1` | Reject non-`ALI-BOSS-` keys on /v1 (default 0 = dual mode) |
| `SESSION_SECRET`, `ENCRYPTION_KEY` | Session namespace / AES-256-GCM secrets |
| `PAYMENT_GATEWAY` | `razorpay` (default) or `mock` |
| `PAYMENT_KEY_ID`, `PAYMENT_KEY_SECRET` | Razorpay Basic-auth credentials |
| `PAYMENT_WEBHOOK_SECRET` | HMAC over the **raw** webhook body |
| `PAYMENT_WEBHOOK_MAX_AGE_SEC` | Replay window for timestamped events (default 300) |
| `SAAS_BASE_URL`, `SAAS_COOKIE_SECURE` | Email links, CSRF origin, Secure cookie |
| `SAAS_INTERNAL_BASE_URL` | Loopback base URL the playground re-enters (default `http://127.0.0.1:$PORT`) |
| `DASHBOARD_ORIGINS` | CORS allowlist if the SPA is on a different origin |
| `EMAIL_PROVIDER`, `EMAIL_PROVIDER_KEY`, `EMAIL_API_URL`, `EMAIL_FROM` | Transactional mail |
| `DATABASE_URL` | **Documented for production; see §8 — adapter still required** |
| `FREEAPI_DB_DRIVER=node-sqlite` | Use Node's built-in SQLite driver (no native addon) |
| `SAAS_ADMIN_EMAIL`, `SAAS_ADMIN_PASSWORD` | First-boot admin (min 12 chars) |

Secrets are never returned by any API (including `/api/saas/admin/system`) and
`.env` is git-ignored.

## 3. Database

Migration `20261027_000001_saas_core.ts` creates (all prefixed `saas_` so the
existing `users`, `sessions`, `api_keys`, `requests`, `settings` tables keep
their meaning for the operator console):

`saas_tenants`, `saas_users`, `saas_sessions`, `saas_plans`,
`saas_subscriptions`, `saas_payments`, `saas_api_keys`, `saas_provider_keys`,
`saas_usage_records`, `saas_webhook_events`, `saas_audit_logs`,
`saas_password_resets`, `saas_email_verifications`, `saas_email_outbox`,
`saas_refunds`, `saas_invoices`, `saas_rate_limits`.

Four plans are seeded (FREE ₹0, STARTER ₹299, PRO ₹799, BUSINESS ₹1,999) with
JSON limits. **Prices are never hard-coded in the client** — `/api/saas/plans`
and the admin panel are the only source of truth.

Design for portability: TEXT UUID primary keys, INTEGER epoch-ms timestamps,
TEXT JSON columns, 0/1 booleans, a partial unique index for one live
subscription per tenant, and `INSERT … ON CONFLICT` for atomic counters.

**Tenant isolation:** every query is scoped to the tenant resolved from the
authenticated session (`requireSaasAuth`) or the API key hash
(`resolveApiKey`). A `tenant_id`/`user_id` in a request body is ignored.
Tests assert cross-tenant reads/reveals return 404.

## 4. HTTP API

Public — `GET /api/saas/config`, `/plans`, `/models`, `/docs`;
`POST /api/saas/auth/signup|login|logout|forgot-password|reset-password|verify-email`.

Session-gated — `/api/saas/auth/me`, `change-password`, `/overview`,
`/subscription`, `/usage`, `/analytics`, `/billing`, `/catalog`, `/routing`,
`/account`, `/api-keys` (create/reveal/rotate/revoke/delete),
`/provider-keys` (add/list/toggle/delete), `/payments/order`,
`/payments/verify`, `/payments`, `/payments/:id/refund` (admin),
`/playground/run`.

Admin — `/api/saas/admin/stats|users|users/:id|users/:id/{suspend,unsuspend,plan,extend,cancel,reset-api-access}|plans|payments|payments/:id/refund|revenue|subscriptions|webhooks|audit-logs|email-outbox|system`.

Webhook — `POST /api/webhooks/payment` (raw body; no session).

Core (unchanged) — `POST /v1/chat/completions`, `/v1/responses`, `/v1/messages`,
`/v1/embeddings`, `GET /v1/models`, `/v1beta/*`, `/mcp`.

Error contract for all SaaS endpoints:
```json
{ "error": { "message": "Subscription expired", "type": "subscription_error", "code": "subscription_expired" } }
```
`401` invalid key · `403` subscription · `429` quota/rate limit.

## 5. Payment flow (Razorpay)

```
Choose plan ─► POST /api/saas/payments/order
                 └─ pending row + gateway order (amount from DB, never from client)
              ─► Razorpay Checkout (key_id, order_id, amount)
Customer pays ─► browser returns razorpay_{order_id,payment_id,signature}
              ─► POST /api/saas/payments/verify
                   1. HMAC(order_id|payment_id, key_secret) === signature
                   2. server-to-server GET /v1/payments/:id
                   3. compare status=captured, order id, amount, currency with OUR row
                   4. mark paid → invoice → idempotent subscription activation
Gateway ─────► POST /api/webhooks/payment
                   1. HMAC(webhook_secret, RAW body) === x-razorpay-signature
                   2. timestamp replay check (when header present)
                   3. UNIQUE(gateway,event_id) → duplicate events ignored
                   4. amount/order/currency re-check → activation keyed on payment.id
Refund ──────► admin POST /api/saas/payments/:id/refund or refund webhook
                   → payment 'refunded' → paid subscription cancelled → FREE restored
```

**A browser "Payment Successful" message never activates anything.** Configure
these webhook events in the Razorpay dashboard: `payment.captured`, `order.paid`,
`payment.failed`, `refund.processed`. Webhook URL:
`https://yourdomain.com/api/webhooks/payment`.

`PaymentGateway` in `server/src/saas/payments/gateway.ts` is an interface —
adding Stripe/PayPal means one new adapter, no changes to checkout, webhooks,
refunds or subscriptions.

## 6. API gateway / quotas / streaming

`saasGateway()` only intercepts `ALI-BOSS-…` bearer tokens (or loopback internal
playground calls). Other tokens fall through to the original unified-key
handling unless `SAAS_REQUIRE_KEYS=1`. Order of checks: key hash → tenant →
account → subscription (with lazy expiry) → plan capabilities (streaming,
embeddings) → daily/monthly request+token quota → DB-backed RPM/TPM window →
`next()` into the **original** router.

After those checks pass, the gateway rewrites the downstream `Authorization`
header to the operator's unified FreeLLMAPI key (and drops `x-api-key` /
`x-goog-api-key`). The core routers keep their original auth gate untouched —
they simply see an already-authorized internal request. The customer key is
consumed at the gateway, never forwarded to a provider and never echoed back.

Usage recording observes `res.write`/`res.end` (bounded to 256 KB) and writes one
`saas_usage_records` row on `finish`, extracting OpenAI/Anthropic/Gemini usage
(including the final SSE usage frame) plus `X-Provider`, `X-Model` and
`X-Request-ID`. The stream itself is never buffered or re-serialized — a
regression test asserts the SSE bytes arrive unchanged.

## 7. Security

scrypt password hashes · SHA-256-hashed API keys with AES-256-GCM encrypted
reveal copy · AES-256-GCM provider keys (masked in every response, never in
logs/audit) · opaque hashed sessions in HttpOnly/SameSite=Lax(/Secure) cookies ·
per-(email,IP) login lockout · origin-based CSRF check for cookie-only mutations ·
per-IP admin/proxy rate limiters · CSP/security headers from Helmet · input
validation on every mutation · parameterized SQL everywhere · webhook raw-body
HMAC + replay window + event-id dedup · audit log for privileged actions ·
FreeLLMAPI config dumps exclude **all** `saas_*` tables (customer credentials
must never ride in a file an operator emails around).

## 8. PostgreSQL (production) — IMPORTANT STATUS

The schema is PostgreSQL-portable by design, but **the shipped data layer is
SQLite** (the FreeLLMAPI `Db` interface). `DATABASE_URL` is documented but there
is **no `pg` adapter wired in this pass**. For production you must:

1. Add `pg` (or `@neon/serverless`, `postgres`, …) and implement
   `server/src/saas/store.ts` against the `Db`-like query surface used in
   `server/src/saas/**` (`prepare(sql).get/all/run`, `exec`, `transaction`).
2. Port the migration in `20261027_000001_saas_core.ts`: `TEXT` UUIDs →
   `uuid`, `INTEGER` epoch-ms → `timestamptz`/`bigint`, `limits_json` →
   `jsonb`, `0/1` → `boolean`, `INSERT OR IGNORE` → `ON CONFLICT DO NOTHING`,
   `strftime` → `date_trunc`, `AUTOINCREMENT` → `identity`.
3. Point `DATABASE_URL` at managed PostgreSQL and keep the FreeLLMAPI router's
   own SQLite DB for model/routing state (or migrate that too).
4. Enable provider-managed daily backups + point-in-time recovery, and verify a
   restore in staging. The built-in `/api/backups` dump intentionally excludes
   customer tables — it is a router-config backup, **not** your SaaS DB backup.

Until step 1–3 are done, do **not** run a public paid service on a single
ephemeral SQLite file. This is the single biggest remaining gap versus §34/§41
of the spec.

## 9. Email

All transactional mail is written to `saas_email_outbox` (welcome, verification,
password reset, payment success, activation, expiring/expired, payment failed,
refund) and retried by `dispatchOutbox()`. With `EMAIL_PROVIDER_KEY` set it
delivers through a Resend-compatible HTTP API (or `EMAIL_API_URL` custom).
Without it, mail stays queued and is visible in Admin → Emails; reset/verification
tokens are also returned in non-production responses so local installs work
without an inbox.

## 10. Deployment notes

- Single domain: `https://yourdomain.com` serves the SPA, `/api`, `/v1`,
  `/dashboard`, `/admin`, `/console`. Or split `app.` and `api.` origins and set
  `DASHBOARD_ORIGINS` + `SAAS_BASE_URL`.
- Run behind HTTPS (Caddy/nginx/Render). Set `TRUST_PROXY=1`,
  `SAAS_COOKIE_SECURE=1`, `NODE_ENV=production`.
- Build: `npm run build` (server → `server/dist`, client → `client/dist`), then
  `npm run start -w server`.
- The playground re-enters the same server over loopback; if your runtime
  isolates loopback, set `SAAS_INTERNAL_BASE_URL` to a reachable internal URL.
- Monitoring: watch `/api/ping`, `/api/saas/admin/stats`, the email outbox and
  `saas_webhook_events` with `status='failed'`.

## 11. Tests

```bash
npm run test -w server -- src/__tests__/saas/saas-flow.test.ts
```

24 end-to-end tests against a real Express app + in-memory DB cover: plans,
signup validation/duplicates, tenant creation, login/logout, password reset,
tenant isolation, API key hashing/reveal/rotate/revoke, provider key encryption,
checkout idempotency, bad signature rejection, verified activation, unsigned
webhook rejection, duplicate webhook idempotency, amount-mismatch rejection,
refund downgrade, usage extraction (JSON + SSE), invalid key 401, streaming
passthrough, quota 429, subscription 403, legacy endpoints, admin RBAC,
revenue, plan editing and audit logs.

The full existing suite (`npm run test -w server`, 4,200+ tests) was also run.
In this sandbox 18 test files cannot even be collected because they import the
optional native `better-sqlite3` addon directly and it cannot be compiled here
(no `nodejs.org` headers). Those are environment failures, not regressions; all
4283 collectable tests pass, including the original backup-credential policy
test which now also passes with the SaaS tables present.

## 12. Acceptance criteria — honest status

| Area | Status |
| --- | --- |
| Public website (/ /features /models /pricing /docs /login /signup /forgot-password /contact /terms /privacy /refund), dark/red responsive UI | ✅ |
| Signup / login / logout / password reset / email verification, scrypt hashing, duplicate prevention, login lockout | ✅ |
| Multi-tenancy, per-tenant isolation, session/API-key identity (body tenant_id ignored) | ✅ |
| DB tables (users, sessions, tenants, plans, subscriptions, payments, api_keys, provider_keys, usage_records, webhook_events, audit_logs, password_resets, email_verifications, invoices, refunds, rate_limits, email outbox) | ✅ (prefixed `saas_`) |
| API keys create/reveal/copy/rotate/revoke/delete, hashed at rest | ✅ |
| Provider keys tenant-scoped + encrypted + masked | ✅ |
| Existing /v1 endpoints, streaming, tool calling, fallback, routing, playground, analytics preserved | ✅ (gateway is additive; regression tests for streaming + legacy endpoints) |
| Subscription enforcement (401/403/429), quota, RPM/TPM, usage tracking incl. streaming | ✅ |
| Admin panel: users, plans, payments, revenue, subscriptions, webhooks, audit, email, system | ✅ |
| Pricing admin-configurable (no hard-coded prices) | ✅ |
| Payment: create order, checkout, signature verification, webhook dedup, amount/order verification, activation, refund | ✅ (Razorpay adapter + mock for local) |
| Docs page with curl/JS/Python/PHP examples, consistent error format | ✅ |
| PostgreSQL authoritative store + verified production backups | ⚠️ **Not wired** — schema is portable; adapter + migrations + managed backup still required (§8) |
| Per-tenant provider keys injected into the core router's provider chain | ⚠️ Stored encrypted and isolated, but the core router still uses its global `api_keys` table. Routing preferences are saved per tenant but not yet applied to core routing decisions. This is the second major remaining gap (§12/§18). |
| Automatic recurring renewals (gateway subscription IDs) | ⚠️ Manual renewal via checkout; expiry downgrades to FREE. Recurring token/subscription support not implemented. |
| Email delivery, HTTPS/domain, live Razorpay keys, monitoring, CDN, production backups | ⚠️ Requires the operator's accounts/secrets/deployment; seams + docs are in place |
| CAPTCHA / distributed rate limiting / WAF | ❌ Not included (login throttle + per-IP limiters + DB counters are present) |

**Bottom line:** this is a working, tested SaaS foundation covering Phases 1–10
and 12 of the specification. It is **not yet production-ready for paid
customers** until the PostgreSQL adapter, per-tenant provider-key bridging and
the operator's live credentials/domain are in place.
