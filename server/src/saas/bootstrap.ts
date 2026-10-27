import { ensureBootstrapAdmin } from './auth/service.js';
import { paymentConfigured, saasEnabled } from './config.js';
import { dispatchOutbox } from './email.js';
import { sweepSubscriptions } from './subscriptions/service.js';

let started = false;

/** Called once after initDb(). Idempotent so tests and the CLI can call it. */
export function startSaas(): void {
  if (!saasEnabled() || started) return;
  started = true;

  ensureBootstrapAdmin();

  if (!paymentConfigured()) {
    console.warn('[saas] payment gateway credentials are incomplete. Set PAYMENT_KEY_ID / PAYMENT_KEY_SECRET / PAYMENT_WEBHOOK_SECRET, or PAYMENT_GATEWAY=mock for local testing.');
  }

  // Hourly: subscription expiry/expiring notices and queued email delivery.
  // unref() so a short-lived process (tests, CLI) is not held open by a timer.
  const timer = setInterval(() => {
    try {
      const result = sweepSubscriptions();
      if (result.expired) console.log(`[saas] expired ${result.expired} subscription(s)`);
      void dispatchOutbox(50);
    } catch (err) {
      console.error('[saas] background sweep failed:', (err as Error).message);
    }
  }, 60 * 60 * 1000);
  timer.unref?.();

  console.log('[saas] ALI-BOSS layer active (website + billing + API gateway)');
}
