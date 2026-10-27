import type { Response } from 'express';

// One error contract for the whole public API surface:
//   { "error": { "message", "type", "code" } }
// FreeLLMAPI's own /v1 router keeps its OpenAI-shaped errors untouched.

export type SaasErrorType =
  | 'authentication_error'
  | 'authorization_error'
  | 'invalid_request_error'
  | 'subscription_error'
  | 'rate_limit_error'
  | 'quota_exceeded'
  | 'payment_error'
  | 'not_found'
  | 'server_error';

export class SaasHttpError extends Error {
  constructor(
    public status: number,
    public type: SaasErrorType,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = type;
  }
}

export function saasError(res: Response, status: number, type: SaasErrorType, code: string, message: string): void {
  res.status(status).json({ error: { message, type, code } });
}

export function fail(status: number, type: SaasErrorType, code: string, message: string): never {
  throw new SaasHttpError(status, type, code, message);
}

// Explicit signatures are load-bearing: TypeScript only applies
// never-returning control-flow narrowing when the call target has an explicit
// type annotation. Without this, every `if (!row) errors.notFound()` would
// leave `row` possibly undefined for the rest of the function.
interface ErrorFactories {
  unauthenticated: () => never;
  invalidCredentials: () => never;
  forbidden: () => never;
  badRequest: (message?: string) => never;
  notFound: (what?: string) => never;
  invalidKey: () => never;
  subscription: (code: string, message: string) => never;
  quota: (code: string, message: string) => never;
  rateLimit: (message?: string) => never;
  payment: (code: string, message: string) => never;
}

export const errors: ErrorFactories = {
  unauthenticated: () => fail(401, 'authentication_error', 'authentication_required', 'Sign in to continue.'),
  invalidCredentials: () => fail(401, 'authentication_error', 'invalid_credentials', 'Email or password is incorrect.'),
  forbidden: () => fail(403, 'authorization_error', 'forbidden', 'You do not have access to this resource.'),
  badRequest: (message = 'Invalid request.') => fail(400, 'invalid_request_error', 'invalid_request', message),
  notFound: (what = 'Resource') => fail(404, 'not_found', 'not_found', `${what} not found.`),
  invalidKey: () => fail(401, 'authentication_error', 'invalid_api_key', 'Invalid or revoked API key.'),
  subscription: (code: string, message: string) => fail(403, 'subscription_error', code, message),
  quota: (code: string, message: string) => fail(429, 'quota_exceeded', code, message),
  rateLimit: (message = 'Too many requests. Slow down.') => fail(429, 'rate_limit_error', 'rate_limit_exceeded', message),
  payment: (code: string, message: string) => fail(400, 'payment_error', code, message),
};
