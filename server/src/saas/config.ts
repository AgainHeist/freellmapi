import crypto from 'crypto';

// All ALI-BOSS secrets live in the environment, never in source control.
// See .env.example (the ALI-BOSS section) and docs/SAAS.md.
//
// Values are read per call (not cached at module load) so tests and the
// bootstrap CLI can flip SAAS_ENABLED / PAYMENT_GATEWAY without importing
// order mattering.

export type GatewayName = 'razorpay' | 'mock';

export interface PaymentCredentials {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
}

const INTERNAL_SECRET = crypto.randomBytes(32).toString('hex');

export function saasEnabled(): boolean {
  const v = (process.env.SAAS_ENABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** When true, /v1 rejects any Bearer token that is not an ALI-BOSS SaaS key.
 *  Default false = dual mode: the operator's original FreeLLMAPI unified key
 *  keeps working while customers use their own keys. */
export function saasRequireKeys(): boolean {
  const v = (process.env.SAAS_REQUIRE_KEYS ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export function gatewayName(): GatewayName {
  return (process.env.PAYMENT_GATEWAY ?? '').trim().toLowerCase() === 'mock' ? 'mock' : 'razorpay';
}

export function paymentCredentials(): PaymentCredentials {
  return {
    keyId: process.env.PAYMENT_KEY_ID ?? process.env.RAZORPAY_KEY_ID ?? '',
    keySecret: process.env.PAYMENT_KEY_SECRET ?? process.env.RAZORPAY_KEY_SECRET ?? '',
    webhookSecret: process.env.PAYMENT_WEBHOOK_SECRET ?? process.env.RAZORPAY_WEBHOOK_SECRET ?? '',
  };
}

/** Fail loudly in production if payment is configured but incomplete. */
export function paymentConfigured(): boolean {
  if (gatewayName() === 'mock') return true;
  const c = paymentCredentials();
  return Boolean(c.keyId && c.keySecret && c.webhookSecret);
}

export function sessionSecret(): string {
  return process.env.SESSION_SECRET ?? process.env.SAAS_SESSION_SECRET ?? '';
}

export function publicBaseUrl(): string {
  return (process.env.SAAS_BASE_URL ?? process.env.PUBLIC_BASE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
}

/** Loopback URL the playground endpoint uses to re-enter the SAME Express
 *  app, so the request passes through the quota/usage gateway and the original
 *  FreeLLMAPI router instead of reimplementing inference. */
export function internalBaseUrl(): string {
  const explicit = process.env.SAAS_INTERNAL_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, '');
  return `http://127.0.0.1:${process.env.PORT ?? '3001'}`;
}

export function internalSecret(): string {
  return INTERNAL_SECRET;
}

export function secureCookies(): boolean {
  // Behind HTTPS (or an env override) the session cookie is Secure. Over plain
  // HTTP on localhost a Secure cookie would never be sent back.
  return (process.env.SAAS_COOKIE_SECURE ?? '').trim() === '1'
    || (process.env.NODE_ENV === 'production' && publicBaseUrl().startsWith('https://'));
}

export function bootstrapAdmin(): { email: string; password: string } | null {
  const email = process.env.SAAS_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SAAS_ADMIN_PASSWORD;
  if (!email || !password || password.length < 12) return null;
  return { email, password };
}

export function emailConfig(): { from: string; apiKey: string; provider: string } {
  return {
    from: process.env.EMAIL_FROM ?? 'ALI-BOSS <no-reply@ali-boss.local>',
    apiKey: process.env.EMAIL_PROVIDER_KEY ?? '',
    provider: process.env.EMAIL_PROVIDER ?? 'resend',
  };
}

/** Webhook replay window. Razorpay signs the raw body, not a timestamp, but
 *  we still bound delivery age when the gateway supplies a timestamp header. */
export function webhookMaxAgeSec(): number {
  const n = Number(process.env.PAYMENT_WEBHOOK_MAX_AGE_SEC ?? 300);
  return Number.isFinite(n) && n > 0 ? n : 300;
}
