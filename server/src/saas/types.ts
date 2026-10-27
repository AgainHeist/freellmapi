// Row shapes shared by every SaaS module. Column names are snake_case (matching
// the DB) on purpose: keeping one spelling avoids a mapper drift every time a
// query changes. API responses use the serializers in each service instead.

export interface TenantRow {
  id: string;
  name: string;
  owner_user_id: string | null;
  status: 'active' | 'suspended';
  settings_json: string;
  created_at: number;
  updated_at: number;
}

export interface UserRow {
  id: string;
  tenant_id: string;
  email: string;
  name: string;
  password_hash: string;
  role: 'user' | 'admin';
  status: 'active' | 'suspended';
  email_verified: number;
  referral_code: string | null;
  referred_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface SessionRow {
  id: string;
  token_hash: string;
  user_id: string;
  tenant_id: string;
  expires_at: number;
  ip: string | null;
  user_agent: string | null;
  created_at: number;
}

export interface PlanLimits {
  requestsPerMinute: number;
  requestsPerDay: number;
  requestsPerMonth: number;
  tokensPerMinute: number;
  tokensPerDay: number;
  tokensPerMonth: number;
  maxModels: number;
  streaming: boolean;
  embeddings: boolean;
  providerAccess: string[];
  support: string;
}

export interface PlanRow {
  id: string;
  slug: string;
  name: string;
  price_minor: number;
  currency: string;
  billing_cycle_days: number;
  limits_json: string;
  features_json: string;
  is_active: number;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export type SubscriptionStatus = 'trial' | 'active' | 'past_due' | 'expired' | 'cancelled' | 'suspended';

export interface SubscriptionRow {
  id: string;
  tenant_id: string;
  plan_id: string;
  status: SubscriptionStatus;
  start_at: number;
  end_at: number;
  renewal_at: number | null;
  payment_id: string | null;
  created_at: number;
  updated_at: number;
}

export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'refunded' | 'cancelled';

export interface PaymentRow {
  id: string;
  order_id: string;
  user_id: string;
  tenant_id: string;
  plan_id: string;
  amount_minor: number;
  currency: string;
  status: PaymentStatus;
  gateway: string;
  gateway_payment_id: string | null;
  gateway_order_id: string | null;
  gateway_reference: string | null;
  verified_at: number | null;
  metadata_json: string;
  created_at: number;
  updated_at: number;
}

export interface ApiKeyRow {
  id: string;
  tenant_id: string;
  user_id: string;
  name: string;
  prefix: string;
  key_hash: string;
  secret_enc: string;
  secret_iv: string;
  secret_tag: string;
  status: 'active' | 'revoked';
  last_used_at: number | null;
  created_at: number;
  revoked_at: number | null;
}

export interface UsageRecordInput {
  tenantId: string;
  userId?: string | null;
  apiKeyId?: string | null;
  requestId?: string | null;
  endpoint: string;
  model?: string | null;
  provider?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  status: 'ok' | 'error';
  error?: string | null;
}

/** Attached to Express requests by the SaaS auth / gateway middleware. */
export interface SaasContext {
  user?: UserRow;
  tenant?: TenantRow;
  plan?: PlanRow;
  limits?: PlanLimits;
  subscription?: SubscriptionRow;
  apiKey?: ApiKeyRow;
  /** Internal playground calls carry a resolved tenant but no API key. */
  internal?: boolean;
}
