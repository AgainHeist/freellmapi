import crypto from 'crypto';
import { gatewayName, paymentCredentials, type GatewayName } from '../config.js';
import { hmacSha256Hex, safeEqual } from '../util.js';

// Gateway adapter. Every money-moving decision in the SaaS layer goes through
// this interface, so swapping Razorpay for Stripe/PayPal means adding one
// adapter — not touching checkout, webhooks, refunds or subscriptions.

export interface GatewayOrder {
  id: string;
  amount: number;
  currency: string;
  status: string;
  receipt: string;
}

export interface GatewayPayment {
  id: string;
  orderId: string;
  amount: number;
  currency: string;
  status: string; // 'captured' | 'authorized' | 'failed' | ...
  method?: string;
}

export interface GatewayRefund {
  id: string;
  status: string;
  amount: number;
}

export interface PaymentGateway {
  readonly name: GatewayName;
  createOrder(input: { amountMinor: number; currency: string; receipt: string; notes: Record<string, string> }): Promise<GatewayOrder>;
  fetchPayment(paymentId: string): Promise<GatewayPayment>;
  /** Verify the signature the browser returns after checkout. */
  verifyCheckoutSignature(input: { orderId: string; paymentId: string; signature: string }): boolean;
  /** Verify the RAW webhook body (never a re-serialized JSON object). */
  verifyWebhookSignature(rawBody: Buffer | string, signature: string): boolean;
  refund(paymentId: string, amountMinor: number, reason?: string): Promise<GatewayRefund>;
}

const RAZORPAY_API = 'https://api.razorpay.com/v1';

function assertCredentials(): { keyId: string; keySecret: string; webhookSecret: string } {
  const c = paymentCredentials();
  if (!c.keyId || !c.keySecret || !c.webhookSecret) {
    throw new Error('Payment gateway is not configured. Set PAYMENT_KEY_ID, PAYMENT_KEY_SECRET and PAYMENT_WEBHOOK_SECRET (or PAYMENT_GATEWAY=mock for local development).');
  }
  return c;
}

function basicAuth(keyId: string, keySecret: string): string {
  return `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;
}

async function razorpayFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { keyId, keySecret } = assertCredentials();
  const res = await fetch(`${RAZORPAY_API}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: basicAuth(keyId, keySecret),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) {
    const message = (body.error as { description?: string } | undefined)?.description ?? `Gateway returned ${res.status}`;
    throw new Error(message);
  }
  return body as T;
}

export const razorpayGateway: PaymentGateway = {
  name: 'razorpay',

  async createOrder({ amountMinor, currency, receipt, notes }) {
    const body = await razorpayFetch<Record<string, unknown>>('/orders', {
      method: 'POST',
      body: JSON.stringify({ amount: amountMinor, currency, receipt, notes }),
    });
    return {
      id: String(body.id),
      amount: Number(body.amount),
      currency: String(body.currency),
      status: String(body.status ?? 'created'),
      receipt,
    };
  },

  async fetchPayment(paymentId) {
    const body = await razorpayFetch<Record<string, unknown>>(`/payments/${encodeURIComponent(paymentId)}`);
    return {
      id: String(body.id),
      orderId: String(body.order_id ?? ''),
      amount: Number(body.amount),
      currency: String(body.currency),
      status: String(body.status),
      method: body.method ? String(body.method) : undefined,
    };
  },

  verifyCheckoutSignature({ orderId, paymentId, signature }) {
    const { keySecret } = assertCredentials();
    const expected = hmacSha256Hex(keySecret, `${orderId}|${paymentId}`);
    return safeEqual(expected, signature);
  },

  verifyWebhookSignature(rawBody, signature) {
    const { webhookSecret } = assertCredentials();
    const expected = hmacSha256Hex(webhookSecret, Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody));
    return safeEqual(expected, signature);
  },

  async refund(paymentId, amountMinor, reason) {
    const body = await razorpayFetch<Record<string, unknown>>(`/payments/${encodeURIComponent(paymentId)}/refund`, {
      method: 'POST',
      body: JSON.stringify({ amount: amountMinor, notes: reason ? { reason } : {} }),
    });
    return { id: String(body.id), status: String(body.status ?? 'processed'), amount: Number(body.amount) };
  },
};

// ── Mock gateway ───────────────────────────────────────────────────────────
// Local dev + regression tests need the full checkout → webhook → activation
// path without real money or outbound network. It implements the SAME
// signature rules (HMAC over raw bytes) so tests exercise the real security
// code rather than a bypass.
interface MockOrder { id: string; amount: number; currency: string; receipt: string; notes: Record<string, string> }
const mockOrders = new Map<string, MockOrder>();
const mockPayments = new Map<string, GatewayPayment>();
const mockRefunds = new Map<string, string>();

function mockSecret(): string {
  return paymentCredentials().webhookSecret || 'ali-boss-mock-webhook-secret';
}

export const mockGateway: PaymentGateway = {
  name: 'mock',

  async createOrder({ amountMinor, currency, receipt, notes }) {
    const id = `order_mock_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
    mockOrders.set(id, { id, amount: amountMinor, currency, receipt, notes });
    return { id, amount: amountMinor, currency, status: 'created', receipt };
  },

  async fetchPayment(paymentId) {
    const existing = mockPayments.get(paymentId);
    if (existing) return existing;
    // Deterministic: a mock payment id embeds its order id, so a test with
    // several orders always resolves the right one (no "first match" bug).
    const orderId = paymentId.startsWith('pay_mock_') ? paymentId.slice('pay_mock_'.length) : '';
    const order = mockOrders.get(orderId);
    if (!order) throw new Error('Mock payment not found');
    const created: GatewayPayment = {
      id: paymentId,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      status: 'captured',
      method: 'mock',
    };
    mockPayments.set(paymentId, created);
    return created;
  },

  verifyCheckoutSignature({ orderId, paymentId, signature }) {
    return safeEqual(hmacSha256Hex(mockSecret(), `${orderId}|${paymentId}`), signature);
  },

  verifyWebhookSignature(rawBody, signature) {
    return safeEqual(
      hmacSha256Hex(mockSecret(), Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody)),
      signature,
    );
  },

  async refund(paymentId, amountMinor) {
    const id = `rfnd_mock_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    mockRefunds.set(paymentId, id);
    return { id, status: 'processed', amount: amountMinor };
  },
};

/** Test helper: a valid mock checkout/webhook signature. Never used in prod. */
export function mockSign(payload: string): string {
  return hmacSha256Hex(mockSecret(), payload);
}

/** Given a gateway order id, produce the mock payment id the gateway will
 *  resolve back to that exact order. */
export function mockPaymentIdFor(orderId: string): string {
  return `pay_mock_${orderId}`;
}

export function activeGateway(): PaymentGateway {
  return gatewayName() === 'mock' ? mockGateway : razorpayGateway;
}

export { mockRefunds };
