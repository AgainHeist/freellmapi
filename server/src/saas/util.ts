import crypto from 'crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { SaasContext } from './types.js';

export function nowMs(): number {
  return Date.now();
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function hmacSha256Hex(secret: string, payload: string | Buffer): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/** Constant-time string comparison that also handles different lengths without
 *  throwing (timingSafeEqual throws on unequal buffers). */
export function safeEqual(a: string, b: string): boolean {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  // Deliberately small: reject the shapes that break mail delivery without
  // pretending a regex can validate an address. Confirmation is by email.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

/** Express request augmented with the resolved tenant context. */
export type SaasRequest = Request & { saas?: SaasContext };

export function saasContext(req: Request): SaasContext {
  return (req as SaasRequest).saas ?? {};
}

export function setSaasContext(req: Request, ctx: SaasContext): void {
  (req as SaasRequest).saas = ctx;
}

/** Express 5 already forwards rejected promises, but this keeps a single
 *  error shape for all SaaS routes and makes the intent explicit. */
export function route(
  fn: (req: Request, res: Response, next: NextFunction) => unknown | Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function startOfUtcDay(ts = Date.now()): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function startOfUtcMonth(ts = Date.now()): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}
