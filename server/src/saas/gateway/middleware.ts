import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { getUnifiedApiKey } from '../../db/index.js';
import { API_KEY_PREFIX, resolveApiKey } from '../apikeys/service.js';
import { internalSecret, saasEnabled, saasRequireKeys } from '../config.js';
import { saasError, SaasHttpError, errors } from '../errors.js';
import { getTenant } from '../auth/service.js';
import { resolveSubscription } from '../subscriptions/service.js';
import { enforceQuota, enforceRateLimit, recordUsage } from '../usage/service.js';
import { newId, nowMs, safeEqual, saasContext, setSaasContext } from '../util.js';

// The API gateway is a SHELL around the existing FreeLLMAPI router. It does
// not rewrite, wrap or re-implement inference: after auth + quota checks it
// calls next() and the original /v1 handlers stream their response straight
// to the socket. Only response *observation* is added.

const MAX_CAPTURE_BYTES = 256 * 1024;

interface UsageTokens { input: number; output: number }

function numberIn(block: string, names: string[]): number {
  for (const name of names) {
    const m = block.match(new RegExp(`"${name}"\\s*:\\s*(\\d+)`));
    if (m) return Number(m[1]);
  }
  return 0;
}

/** Pull token usage from OpenAI/Anthropic/Gemini shaped JSON or SSE chunks.
 *  The LAST usage object wins (OpenAI sends a final usage-only SSE frame). */
export function extractUsage(text: string): UsageTokens {
  let result: UsageTokens = { input: 0, output: 0 };
  const usageRe = /"(?:usage|usageMetadata)"\s*:\s*\{([^{}]*)\}/g;
  for (const match of text.matchAll(usageRe)) {
    const block = match[1] ?? '';
    result = {
      input: numberIn(block, ['prompt_tokens', 'input_tokens', 'promptTokenCount', 'promptTokens']),
      output: numberIn(block, ['completion_tokens', 'output_tokens', 'candidatesTokenCount', 'completionTokens']),
    };
  }
  if (result.input || result.output) return result;

  // Streaming without stream_options.include_usage has no usage frame. Estimate
  // output from the delta content so the quota still accounts for the traffic.
  let chars = 0;
  const contentRe = /"(?:content|text|delta)"\s*:\s*"((?:\\.|[^"\\])*)"/g;
  for (const match of text.matchAll(contentRe)) chars += (match[1] ?? '').length;
  return { input: 0, output: chars > 0 ? Math.ceil(chars / 4) : 0 };
}

function isLoopback(addr: string | undefined): boolean {
  let a = (addr ?? '').trim();
  if (a.startsWith('::ffff:')) a = a.slice(7);
  return a === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

function clientIp(req: Request): string | null {
  return req.socket.remoteAddress ?? req.ip ?? null;
}

function bearer(req: Request): string {
  const h = req.headers.authorization;
  if (!h) return '';
  return h.replace(/^Bearer\s+/i, '').trim();
}

function attachUsageObserver(req: Request, res: Response, ctx: {
  tenantId: string; userId: string | null; apiKeyId: string | null;
  endpoint: string; model: string | null; inputEstimate: number;
}): void {
  const started = nowMs();
  const requestId = newId('req');
  if (!res.headersSent) res.setHeader('X-ALI-BOSS-Request-ID', requestId);
  let captured = '';

  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);

  const capture = (chunk: unknown): void => {
    if (captured.length >= MAX_CAPTURE_BYTES || chunk === null || chunk === undefined) return;
    const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '';
    captured += text.slice(0, MAX_CAPTURE_BYTES - captured.length);
  };

  (res as any).write = function (chunk: any, ...args: any[]) {
    capture(chunk);
      return (originalWrite as any)(chunk, ...args);
  };
  (res as any).end = function (chunk?: any, ...args: any[]) {
    capture(chunk);
      return (originalEnd as any)(chunk, ...args);
  };

  res.once('finish', () => {
    try {
      const tokens = extractUsage(captured);
      const provider = res.getHeader('X-Provider') ?? res.getHeader('X-Routed-Via') ?? null;
      const servedModel = res.getHeader('X-Model');
      const status = res.statusCode;
      let errorMessage: string | null = null;
      if (status >= 400) {
        const msg = captured.match(/"message"\s*:\s*"((?:\\.|[^"\\])*)"/);
        errorMessage = msg?.[1]?.slice(0, 300) ?? `HTTP ${status}`;
      }
      recordUsage({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        apiKeyId: ctx.apiKeyId,
        requestId,
        endpoint: ctx.endpoint,
        model: String(servedModel ?? ctx.model ?? 'unknown'),
        provider: provider ? String(provider) : null,
        inputTokens: tokens.input || ctx.inputEstimate,
        outputTokens: tokens.output,
        latencyMs: nowMs() - started,
        status: status >= 400 ? 'error' : 'ok',
        error: errorMessage,
      });
    } catch (err) {
      // Metering must never break a response that already went out.
      console.error('[saas] usage recording failed:', (err as Error).message);
    }
  });
}

function sendFailure(res: Response, err: unknown): void {
  if (err instanceof SaasHttpError) {
    saasError(res, err.status, err.type, err.code, err.message);
    return;
  }
  console.error('[saas] gateway error:', err);
  saasError(res, 500, 'server_error', 'gateway_error', 'Request could not be processed.');
}

/**
 * /v1 (and /v1beta) gate. Two auth modes:
 *   - `ALI-BOSS-...` customer keys → full SaaS enforcement.
 *   - internal playground calls → loopback + shared secret + resolved tenant.
 * Anything else falls through to FreeLLMAPI's original key handling unless
 * SAAS_REQUIRE_KEYS=1, so existing installs and regression tests keep working.
 */
export function saasGateway(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!saasEnabled()) { next(); return; }

    const token = bearer(req);
    const internalHeader = req.headers['x-ali-boss-internal'];
    const isInternal = typeof internalHeader === 'string'
      && safeEqual(internalHeader, internalSecret())
      && isLoopback(req.socket.remoteAddress);

    if (!token.startsWith(API_KEY_PREFIX) && !isInternal) {
      if (saasRequireKeys()) {
        saasError(res, 401, 'authentication_error', 'invalid_api_key', 'An ALI-BOSS API key is required.');
        return;
      }
      next();
      return;
    }

    void (async () => {
      try {
        let tenantId: string;
        let userId: string | null = null;
        let apiKeyId: string | null = null;

        if (isInternal) {
          const headerTenant = req.headers['x-ali-boss-tenant'];
          const candidate = typeof headerTenant === 'string' ? headerTenant : '';
          const tenant = candidate ? getTenant(candidate) : undefined;
          if (!tenant) errors.unauthenticated();
          tenantId = tenant.id;
          setSaasContext(req, { tenant, internal: true });
        } else {
          const resolved = resolveApiKey(token);
          if (!resolved) errors.invalidKey();
          tenantId = resolved.tenant.id;
          userId = resolved.user.id;
          apiKeyId = resolved.key.id;
          setSaasContext(req, {
            user: resolved.user, tenant: resolved.tenant, apiKey: resolved.key,
          });
        }

        const { subscription, plan, limits } = resolveSubscription(tenantId);
        if (!['trial', 'active'].includes(subscription.status)) {
          errors.subscription('subscription_inactive', `Subscription is ${subscription.status}. Renew from the Billing page.`);
        }
        setSaasContext(req, { ...saasContext(req), plan, limits, subscription });

        const body = (req.body ?? {}) as Record<string, unknown>;
        if (body.stream === true && !limits.streaming) {
          errors.subscription('streaming_not_allowed', 'Streaming is not included in your plan.');
        }
        const endpoint = req.path.startsWith('/embeddings') ? 'embeddings' : req.path;
        if (endpoint === 'embeddings' && !limits.embeddings) {
          errors.subscription('embeddings_not_allowed', 'Embeddings are not included in your plan.');
        }

        enforceQuota(tenantId, limits);
        enforceRateLimit(tenantId, limits);

        const model = typeof body.model === 'string' ? body.model : null;
        const inputEstimate = Math.ceil(JSON.stringify(req.body ?? {}).length / 4);
        attachUsageObserver(req, res, {
          tenantId, userId, apiKeyId,
          endpoint: `${req.method} ${req.baseUrl}${req.path}`.slice(0, 120),
          model, inputEstimate,
        });

        // The ORIGINAL FreeLLMAPI routers authenticate with the operator's
        // unified key (OpenAI Bearer, Anthropic x-api-key, Gemini header).
        // This gateway already authenticated and authorized the customer, so
        // swap in that internal credential for the downstream hop. The
        // customer's key is consumed here, never forwarded to a provider and
        // never echoed in a response. Without this, a valid SaaS key would be
        // rejected with 401 by the core router's own auth gate.
        try {
          req.headers.authorization = `Bearer ${getUnifiedApiKey()}`;
          delete req.headers['x-api-key'];
          delete req.headers['x-goog-api-key'];
        } catch (err) {
          console.error('[saas] could not resolve internal router key:', (err as Error).message);
        }
        next();
      } catch (err) {
        sendFailure(res, err);
      }
    })();
  };
}

export { clientIp };
