import { getDb } from '../../db/index.js';
import { decrypt, encrypt, maskKey } from '../../lib/crypto.js';
import { audit } from '../audit.js';
import { errors } from '../errors.js';
import type { UserRow } from '../types.js';
import { newId, nowMs } from '../util.js';

interface ProviderKeyRow {
  id: string;
  tenant_id: string;
  platform: string;
  label: string;
  secret_enc: string;
  secret_iv: string;
  secret_tag: string;
  masked: string;
  base_url: string | null;
  enabled: number;
  created_at: number;
  revoked_at: number | null;
}

const ALLOWED_PLATFORMS = new Set([
  'google', 'openai', 'anthropic', 'openrouter', 'groq', 'together', 'mistral',
  'cohere', 'cerebras', 'groq', 'huggingface', 'nvidia', 'cloudflare', 'ollama', 'custom',
]);

export function publicProviderKey(row: ProviderKeyRow) {
  return {
    id: row.id,
    platform: row.platform,
    label: row.label,
    masked: row.masked,
    baseUrl: row.base_url,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
  };
}

export function listProviderKeys(tenantId: string): ProviderKeyRow[] {
  return getDb().prepare('SELECT * FROM saas_provider_keys WHERE tenant_id = ? ORDER BY created_at DESC').all(tenantId) as ProviderKeyRow[];
}

export function addProviderKey(input: {
  tenantId: string;
  platform: string;
  label: string;
  secret: string;
  baseUrl?: string;
  actor: Pick<UserRow, 'id' | 'email' | 'role'>;
}) {
  const platform = input.platform.trim().toLowerCase();
  if (!ALLOWED_PLATFORMS.has(platform)) errors.badRequest('Unsupported provider platform.');
  const secret = input.secret.trim();
  if (secret.length < 8 || secret.length > 4096) errors.badRequest('Provider key must be between 8 and 4096 characters.');
  const enc = encrypt(secret);
  const id = newId('pkey');
  getDb().prepare(`
    INSERT INTO saas_provider_keys
      (id, tenant_id, platform, label, secret_enc, secret_iv, secret_tag, masked, base_url, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(
    id, input.tenantId, platform, input.label.trim().slice(0, 80) || platform,
    enc.encrypted, enc.iv, enc.authTag, maskKey(secret), input.baseUrl?.trim() || null, nowMs(),
  );
  // The plaintext secret is NEVER logged, returned or put in an audit row.
  audit({ actor: input.actor, action: 'provider_key.added', targetType: 'provider_key', targetId: id, metadata: { platform } });
  return publicProviderKey(getDb().prepare('SELECT * FROM saas_provider_keys WHERE id = ?').get(id) as ProviderKeyRow);
}

function owned(tenantId: string, id: string): ProviderKeyRow {
  const row = getDb().prepare('SELECT * FROM saas_provider_keys WHERE id = ? AND tenant_id = ?').get(id, tenantId) as ProviderKeyRow | undefined;
  if (!row) errors.notFound('Provider key');
  return row;
}

export function setProviderKeyEnabled(tenantId: string, id: string, enabled: boolean, actor: Pick<UserRow, 'id' | 'email' | 'role'>) {
  owned(tenantId, id);
  getDb().prepare('UPDATE saas_provider_keys SET enabled = ? WHERE id = ? AND tenant_id = ?').run(enabled ? 1 : 0, id, tenantId);
  audit({ actor, action: 'provider_key.updated', targetType: 'provider_key', targetId: id, metadata: { enabled } });
  return publicProviderKey(getDb().prepare('SELECT * FROM saas_provider_keys WHERE id = ?').get(id) as ProviderKeyRow);
}

export function deleteProviderKey(tenantId: string, id: string, actor: Pick<UserRow, 'id' | 'email' | 'role'>): void {
  owned(tenantId, id);
  getDb().prepare('DELETE FROM saas_provider_keys WHERE id = ? AND tenant_id = ?').run(id, tenantId);
  audit({ actor, action: 'provider_key.deleted', targetType: 'provider_key', targetId: id });
}

/** Server-side only. Used by the tenant provider configuration bridge; never
 *  serialized into an HTTP response. */
export function decryptedProviderKeys(tenantId: string): { platform: string; secret: string; baseUrl: string | null }[] {
  return listProviderKeys(tenantId)
    .filter(row => row.enabled && !row.revoked_at)
    .map(row => ({
      platform: row.platform,
      secret: decrypt(row.secret_enc, row.secret_iv, row.secret_tag),
      baseUrl: row.base_url,
    }));
}
