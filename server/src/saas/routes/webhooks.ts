import express, { Router } from 'express';
import { activeGateway } from '../payments/gateway.js';
import { processWebhook } from '../payments/service.js';
import { webhookMaxAgeSec } from '../config.js';
import { sha256 } from '../util.js';

export const paymentWebhookRouter = Router();

/**
 * POST /api/webhooks/payment
 *
 * Mounted BEFORE express.json() in app.ts: the signature is computed over the
 * exact bytes the gateway sent. Re-serializing a parsed object changes
 * whitespace/key order and breaks verification.
 */
paymentWebhookRouter.post(
  '/',
  express.raw({ type: '*/*', limit: '1mb' }),
  (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body as Buffer : Buffer.from(req.body ? JSON.stringify(req.body) : '');
    const rawText = raw.toString('utf8');

    let payload: Record<string, unknown> = {};
    try {
      payload = rawText ? JSON.parse(rawText) as Record<string, unknown> : {};
    } catch {
      res.status(400).json({ error: { message: 'Invalid JSON body.', type: 'invalid_request_error', code: 'invalid_webhook_body' } });
      return;
    }

    // Optional replay defence for gateways that send a signed timestamp.
    const timestampHeader = req.headers['x-ali-boss-timestamp'] ?? req.headers['x-razorpay-timestamp'];
    if (timestampHeader) {
      const ts = Number(String(timestampHeader));
      if (Number.isFinite(ts) && Math.abs(Date.now() / 1000 - ts) > webhookMaxAgeSec()) {
        res.status(400).json({ error: { message: 'Webhook timestamp outside the allowed window.', type: 'invalid_request_error', code: 'stale_webhook' } });
        return;
      }
    }

    const signature = String(
      req.headers['x-razorpay-signature'] ?? req.headers['x-ali-boss-signature'] ?? '',
    );
    let signatureValid = false;
    try {
      signatureValid = Boolean(signature) && activeGateway().verifyWebhookSignature(raw, signature);
    } catch {
      signatureValid = false;
    }

    const eventId = String(
      req.headers['x-razorpay-event-id']
      ?? req.headers['x-ali-boss-event-id']
      ?? payload.event_id
      ?? payload.id
      ?? sha256(rawText),
    );
    const eventType = String(payload.event ?? payload.type ?? 'payment.captured');

    const result = processWebhook({
      gatewayName: activeGateway().name,
      eventId,
      eventType,
      rawBody: rawText,
      signatureValid,
      payload,
    });

    if (!signatureValid) {
      res.status(400).json({ error: { message: 'Webhook signature verification failed.', type: 'payment_error', code: 'invalid_signature' }, result });
      return;
    }
    if (result.reason && !['duplicate_event'].includes(result.reason)) {
      // Business-level failures (amount mismatch, unknown order) must not be
      // retried forever by the gateway, but should be visible in admin logs.
      res.status(202).json({ ok: false, ...result });
      return;
    }
    res.json({ ok: true, ...result });
  },
);
