import { Router } from 'express';
import { getDb } from '../../db/index.js';
import { gatewayName, saasEnabled } from '../config.js';
import { listPlans, publicPlan } from '../plans/service.js';
import { route } from '../util.js';

export const saasPublicRouter = Router();

/** GET /api/saas/config — public brand + capability flags for the SPA. */
saasPublicRouter.get('/config', (_req, res) => {
  res.json({
    brand: 'ALI-BOSS',
    adminLabel: 'ALi-JDHD',
    support: '@alionera',
    saasEnabled: saasEnabled(),
    gateway: gatewayName(),
    currency: 'INR',
  });
});

/** GET /api/saas/plans — admin-editable pricing, never hard-coded in the UI. */
saasPublicRouter.get('/plans', (_req, res) => {
  res.json({ plans: listPlans().map(publicPlan) });
});

interface ModelRow {
  platform: string;
  model_id: string;
  display_name: string;
  context_window: number | null;
  intelligence_rank: number;
  speed_rank: number;
  supports_vision?: number;
  supports_tools?: number;
  size_label?: string;
  monthly_token_budget?: string;
}

function availableModels(limit: number): ModelRow[] {
  return getDb().prepare(`
    SELECT * FROM models WHERE enabled = 1
    ORDER BY intelligence_rank ASC, speed_rank ASC LIMIT ?
  `).all(Math.min(Math.max(1, limit), 1000)) as ModelRow[];
}

/** GET /api/saas/models — live from the existing FreeLLMAPI model catalog. */
saasPublicRouter.get('/models', route((req, res) => {
  const limit = Number(req.query.limit ?? 60);
  const rows = availableModels(Number.isFinite(limit) ? limit : 60);
  res.json({
    count: rows.length,
    models: rows.map(row => ({
      id: row.model_id,
      name: row.display_name,
      provider: row.platform,
      status: 'available',
      context: row.context_window,
      capabilities: {
        vision: Boolean(row.supports_vision),
        tools: Boolean(row.supports_tools),
      },
      size: row.size_label ?? null,
      monthlyBudget: row.monthly_token_budget ?? null,
    })),
  });
}));

/** GET /api/saas/docs — machine-readable quick-start index for the docs page. */
saasPublicRouter.get('/docs', (_req, res) => {
  res.json({
    baseUrl: '/v1',
    auth: 'Authorization: Bearer ALI-BOSS-...',
    endpoints: [
      { method: 'POST', path: '/v1/chat/completions', description: 'OpenAI-compatible chat, streaming supported.' },
      { method: 'POST', path: '/v1/responses', description: 'OpenAI Responses API.' },
      { method: 'POST', path: '/v1/messages', description: 'Anthropic Messages API.' },
      { method: 'POST', path: '/v1/embeddings', description: 'Embeddings.' },
      { method: 'GET', path: '/v1/models', description: 'List models available to your plan.' },
    ],
    errors: {
      401: 'Invalid API key',
      403: 'Subscription inactive or feature not in plan',
      429: 'Quota or rate limit exceeded',
    },
    examples: {
      curl: 'curl -X POST /v1/chat/completions -H "Authorization: Bearer ALI-BOSS-..." -H "Content-Type: application/json" -d \'{"model":"...","messages":[{"role":"user","content":"Hello"}]}\'',
      python: 'from openai import OpenAI\nclient = OpenAI(api_key="ALI-BOSS-...", base_url="https://yourdomain.com/v1")\nprint(client.chat.completions.create(model="...", messages=[{"role":"user","content":"Hello"}]))',
      javascript: 'import OpenAI from "openai";\nconst client = new OpenAI({ apiKey: "ALI-BOSS-...", baseURL: "https://yourdomain.com/v1" });\nawait client.chat.completions.create({ model: "...", messages: [{ role: "user", content: "Hello" }] });',
      php: '$ch = curl_init("/v1/chat/completions");\ncurl_setopt($ch, CURLOPT_HTTPHEADER, ["Authorization: Bearer ALI-BOSS-...", "Content-Type: application/json"]);\ncurl_setopt($ch, CURLOPT_POSTFIELDS, json_encode(["model" => "...", "messages" => [["role" => "user", "content" => "Hello"]]]));',
    },
  });
});
