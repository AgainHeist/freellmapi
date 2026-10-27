#!/usr/bin/env node
/**
 * Create (or verify) the first ALI-BOSS administrator.
 *
 * Usage (from the repo root):
 *   npm run saas:admin -- admin@yourdomain.com a-very-long-password
 *
 * Or set SAAS_ADMIN_EMAIL / SAAS_ADMIN_PASSWORD in .env and run with no args;
 * the server also does this automatically on boot when SAAS_ENABLED=1.
 *
 * Never prints the password. Safe to re-run: an existing account is left
 * untouched (in particular, a customer account is never promoted to admin).
 */
import '../env.js';
import { initDb, getDb } from '../db/index.js';
import { nodeSqliteFactory } from '../db/node-sqlite.js';
import { createAccount, getUserByEmail } from '../saas/auth/service.js';

const email = (process.argv[2] ?? process.env.SAAS_ADMIN_EMAIL ?? '').trim().toLowerCase();
const password = process.argv[3] ?? process.env.SAAS_ADMIN_PASSWORD ?? '';

if (!email || !password) {
  console.error('Usage: npm run saas:admin -- <email> <password>');
  process.exit(1);
}
if (password.length < 12) {
  console.error('Admin password must be at least 12 characters.');
  process.exit(1);
}

process.env.SAAS_ENABLED = '1';
const factory = process.env.FREEAPI_DB_DRIVER === 'node-sqlite' ? { factory: nodeSqliteFactory } : undefined;
initDb(process.env.FREEAPI_DB_PATH?.trim() || undefined, factory);

if (getUserByEmail(email)) {
  console.log(`[saas] admin account ${email} already exists — nothing changed.`);
  process.exit(0);
}

const account = createAccount({ name: 'ALi-JDHD', email, password, role: 'admin' });
getDb().prepare('UPDATE saas_users SET email_verified = 1 WHERE id = ?').run(account.user.id);
console.log(`[saas] admin created: ${email} (tenant ${account.tenant.id})`);
