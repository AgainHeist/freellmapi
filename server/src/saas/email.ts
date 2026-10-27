import { getDb } from '../db/index.js';
import { emailConfig } from './config.js';
import { newId, nowMs } from './util.js';

// Transactional email = durable outbox + pluggable dispatch.
//
// Nothing in the billing path awaits an SMTP/HTTP call: a provider outage
// cannot fail a signup or a payment. Rows are visible in the admin panel and
// retried by dispatchOutbox(); with no EMAIL_PROVIDER_KEY they simply stay
// queued (and reset links are also returned in development — see auth routes).

export type EmailTemplate =
  | 'welcome'
  | 'email_verification'
  | 'password_reset'
  | 'payment_success'
  | 'subscription_activated'
  | 'subscription_expiring'
  | 'subscription_expired'
  | 'payment_failed'
  | 'refund';

const SUBJECTS: Record<EmailTemplate, string> = {
  welcome: 'Welcome to ALI-BOSS',
  email_verification: 'Verify your ALI-BOSS email',
  password_reset: 'Reset your ALI-BOSS password',
  payment_success: 'Payment received — ALI-BOSS',
  subscription_activated: 'Your ALI-BOSS subscription is active',
  subscription_expiring: 'Your ALI-BOSS subscription expires soon',
  subscription_expired: 'Your ALI-BOSS subscription has expired',
  payment_failed: 'ALI-BOSS payment failed',
  refund: 'ALI-BOSS refund processed',
};

export function enqueueEmail(to: string, template: EmailTemplate, body: string): string {
  const id = newId('mail');
  getDb().prepare(`
    INSERT INTO saas_email_outbox (id, to_email, template, subject, body, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'queued', ?)
  `).run(id, to, template, SUBJECTS[template], body, nowMs());
  // Fire-and-forget dispatch. Failures stay queued for the next sweep.
  void dispatchOutbox();
  return id;
}

/** Attempt to deliver queued mail. Resend-compatible HTTP API; set
 *  EMAIL_PROVIDER=custom + EMAIL_API_URL to point at any equivalent service. */
export async function dispatchOutbox(limit = 20): Promise<number> {
  const { apiKey, from, provider } = emailConfig();
  if (!apiKey) return 0;
  const rows = getDb().prepare(
    "SELECT id, to_email, subject, body FROM saas_email_outbox WHERE status = 'queued' ORDER BY created_at LIMIT ?",
  ).all(limit) as { id: string; to_email: string; subject: string; body: string }[];

  const url = provider === 'custom'
    ? (process.env.EMAIL_API_URL ?? '')
    : 'https://api.resend.com/emails';
  if (!url) return 0;

  let sent = 0;
  for (const row of rows) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ from, to: [row.to_email], subject: row.subject, text: row.body }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`email provider returned ${res.status}`);
      getDb().prepare("UPDATE saas_email_outbox SET status = 'sent', sent_at = ? WHERE id = ?").run(nowMs(), row.id);
      sent++;
    } catch (err) {
      getDb().prepare("UPDATE saas_email_outbox SET status = 'failed', error = ? WHERE id = ?")
        .run(String((err as Error).message ?? err).slice(0, 300), row.id);
    }
  }
  return sent;
}
