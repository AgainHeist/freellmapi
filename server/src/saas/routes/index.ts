import { Router } from 'express';
import type { ErrorRequestHandler } from 'express';
import { SaasHttpError, saasError } from '../errors.js';
import { saasAdminRouter } from './admin.js';
import { saasAuthRouter } from './auth.js';
import { saasCustomerRouter } from './customer.js';
import { saasPublicRouter } from './public.js';

/** Mounted at /api/saas. Public endpoints first, then the admin surface, then
 *  the session-gated customer surface. Order matters: /plans and /models are
 *  public, /overview and /api-keys are not. */
export const saasRouter = Router();

saasRouter.use('/auth', saasAuthRouter);
saasRouter.use('/admin', saasAdminRouter);
saasRouter.use(saasPublicRouter);
saasRouter.use(saasCustomerRouter);

saasRouter.use((_req, res) => {
  saasError(res, 404, 'not_found', 'not_found', 'Unknown ALI-BOSS endpoint.');
});

// Router-local error handler keeps the SaaS error contract
// ({ error: { message, type, code } }) even for errors thrown inside async
// handlers, instead of falling through to the core app's OpenAI-shaped handler.
const saasErrorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (res.headersSent) return;
  if (err instanceof SaasHttpError) {
    saasError(res, err.status, err.type, err.code, err.message);
    return;
  }
  console.error('[saas] route error:', err);
  saasError(res, 500, 'server_error', 'internal_error', 'Something went wrong. Please try again.');
};
saasRouter.use(saasErrorHandler);

export { paymentWebhookRouter } from './webhooks.js';
