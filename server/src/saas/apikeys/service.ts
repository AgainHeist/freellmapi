import crypto from 'crypto';
import { getDb } from '../../db/index.js';
import { decrypt, encrypt } from '../../lib/crypto.js';
import { audit } from '../audit.js';
import { errors } from '../errors.js';
import type { ApiKeyRow, TenantRow, UserRow } from '../types.js';
import { newId, nowMs, sha256 } from '../util.js';

export const API_KEY_PREFIX = 'ALI-BOSS-';

function generateKey(): string {
  return `${API_KEY_PREFIX}${crypto.randomBytes(24).toString('hex')}`;
}

function displayPrefix(key: string): string {
  return `${key.slice(0, 17)}…${key.slice(-4)}`;
}

export function publicApiKey(row: ApiKeyRow) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    status: row.status,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

export function createApiKey(input: {
  tenantId: string;
  userId: string;
  name: string;
  actor: Pick<UserRow, 'id' | 'email' | 'role'>;
}): { row: ApiKeyRow; key: string } {
  const name = input.name.trim().slice(0, 80) || 'Default';
  const key = generateKey();
  const secret = encrypt(key);
  const id = newId('akey');
  getDb().prepare(`
    INSERT INTO saas_api_keys
      (id, tenant_id, user_id, name, prefix, key_hash, secret_enc, secret_iv, secret_tag, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
  `).run(
    id, input.tenantId, input.userId, name, displayPrefix(key), sha256(key),
    secret.encrypted, secret.iv, secret.authTag, nowMs(),
  );
  audit({ actor: input.actor, action: 'api_key.created', targetType: 'api_key', targetId: id, metadata: { name } });
  return { row: getDb().prepare('SELECT * FROM saas_api_keys WHERE id = ?').get(id) as ApiKeyRow, key };
}

export function listApiKeys(tenantId: string): ApiKeyRow[] {
  return getDb().prepare('SELECT * FROM saas_api_keys WHERE tenant_id = ? ORDER BY created_at DESC').all(tenantId) as ApiKeyRow[];
}

function ownedKey(tenantId: string, id: string): ApiKeyRow {
  const row = getDb().prepare('SELECT * FROM saas_api_keys WHERE id = ? AND tenant_id = ?').get(id, tenantId) as ApiKeyRow | undefined;
  if (!row) errors.notFound('API key');
  return row;
}

/** Reveal is an explicit, audited, session-authenticated action. */
export function revealApiKey(tenantId: string, id: string, actor: Pick<UserRow, 'id' | 'email' | 'role'>): string {
  const row = ownedKey(tenantId, id);
  if (row.status !== 'active') errors.badRequest('That key has been revoked.');
  audit({ actor, action: 'api_key.revealed', targetType: 'api_key', targetId: id });
  return decrypt(row.secret_enc, row.secret_iv, row.secret_tag);
}

export function rotateApiKey(tenantId: string, id: string, actor: Pick<UserRow, 'id' | 'email' | 'role'>): { row: ApiKeyRow; key: string } {
  const old = ownedKey(tenantId, id);
  getDb().prepare("UPDATE saas_api_keys SET status = 'revoked', revoked_at = ? WHERE id = ? AND tenant_id = ?")
    .run(nowMs(), id, tenantId);
  audit({ actor, action: 'api_key.rotated_out', targetType: 'api_key', targetId: old.id });
  return createApiKey({ tenantId, userId: old.user_id, name: old.name, actor });
}

export function revokeApiKey(tenantId: string, id: string, actor: Pick<UserRow, 'id' | 'email' | 'role'>): ApiKeyRow {
  ownedKey(tenantId, id);
  getDb().prepare("UPDATE saas_api_keys SET status = 'revoked', revoked_at = ? WHERE id = ? AND tenant_id = ?")
    .run(nowMs(), id, tenantId);
  audit({ actor, action: 'api_key.revoked', targetType: 'api_key', targetId: id });
  return getDb().prepare('SELECT * FROM saas_api_keys WHERE id = ?').get(id) as ApiKeyRow;
}

export function deleteApiKey(tenantId: string, id: string, actor: Pick<UserRow, 'id' | 'email' | 'role'>): void {
  ownedKey(tenantId, id);
  getDb().prepare('DELETE FROM saas_api_keys WHERE id = ? AND tenant_id = ?').run(id, tenantId);
  audit({ actor, action: 'api_key.deleted', targetType: 'api_key', targetId: id });
}

/** Hot path: resolve a Bearer token to its tenant. Only the SHA-256 hash is
 *  stored in the DB, so a database dump cannot be used to call the API. */
export function resolveApiKey(rawKey: string): { key: ApiKeyRow; user: UserRow; tenant: TenantRow } | null {
  const db = getDb();
  const key = db.prepare("SELECT * FROM saas_api_keys WHERE key_hash = ? AND status = 'active'").get(sha256(rawKey)) as ApiKeyRow | undefined;
  if (!key) return null;
  const user = db.prepare("SELECT * FROM saas_users WHERE id = ? AND status = 'active'").get(key.user_id) as UserRow | undefined;
  const tenant = db.prepare("SELECT * FROM saas_tenants WHERE id = ? AND status = 'active'").get(key.tenant_id) as TenantRow | undefined;
  if (!user || !tenant || user.tenant_id !== tenant.id || key.tenant_id !== tenant.id) return null;
  db.prepare('UPDATE saas_api_keys SET last_used_at = ? WHERE id = ?').run(nowMs(), key.id);
  return { key, user, tenant };
}
