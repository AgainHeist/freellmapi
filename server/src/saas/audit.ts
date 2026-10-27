import { getDb } from '../db/index.js';
import { newId, nowMs } from './util.js';
import type { UserRow } from './types.js';

/** Every privileged action (admin mutation, key revocation, settings change)
 *  lands here. `actor` is resolved from the session — never from a request
 *  body — so an audit row cannot be forged by a caller. */
export function audit(input: {
  actor?: Pick<UserRow, 'id' | 'email' | 'role'> | null;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}): void {
  getDb().prepare(`
    INSERT INTO saas_audit_logs
      (id, actor_user_id, actor_email, actor_role, action, target_type, target_id, metadata_json, ip, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    newId('audit'),
    input.actor?.id ?? null,
    input.actor?.email ?? null,
    input.actor?.role ?? 'system',
    input.action,
    input.targetType ?? null,
    input.targetId ?? null,
    JSON.stringify(input.metadata ?? {}),
    input.ip ?? null,
    nowMs(),
  );
}
