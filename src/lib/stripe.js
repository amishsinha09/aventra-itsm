// Minimal Stripe REST client (no SDK): form-encoded requests, idempotency keys, webhook signature checks.
import crypto from 'node:crypto';
import { config } from '../config.js';
import { HttpError } from './http.js';

function encode(obj, prefix, out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => (typeof x === 'object' ? encode(x, `${key}[${i}]`, out) : out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(x)}`)));
    else if (typeof v === 'object') encode(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out;
}
export const formEncode = (obj) => encode(obj).join('&');

export async function stripe(method, path, params, { idempotencyKey } = {}) {
  if (!config.stripeKey) throw new HttpError(503, 'Billing is not configured on this server.');
  const url = `${config.stripeApiBase}/v1/${path}${method === 'GET' && params ? `?${formEncode(params)}` : ''}`;
  const headers = { authorization: `Bearer ${config.stripeKey}`, 'content-type': 'application/x-www-form-urlencoded' };
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, { method, headers, body: method === 'GET' ? undefined : formEncode(params || {}), signal: ctrl.signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error(`Stripe ${method} ${path} -> ${r.status}: ${j.error?.message}`);
      throw new HttpError(502, `Payment provider error: ${j.error?.message || r.status}`);
    }
    return j;
  } finally { clearTimeout(t); }
}

// Verify the Stripe-Signature header against the raw request body (tolerance 5 minutes)
export function verifyWebhook(rawBody, header, secret = config.stripeWebhookSecret, toleranceSec = 300) {
  if (!secret) throw new HttpError(503, 'Webhook secret not configured');
  const parts = Object.fromEntries(String(header || '').split(',').map((p) => { const i = p.indexOf('='); return [p.slice(0, i).trim(), p.slice(i + 1)]; }).filter(([k]) => k));
  const sigs = String(header || '').split(',').filter((p) => p.trim().startsWith('v1=')).map((p) => p.trim().slice(3));
  const t = parseInt(parts.t, 10);
  if (!t || !sigs.length) throw new HttpError(400, 'Invalid signature header');
  if (Math.abs(Date.now() / 1000 - t) > toleranceSec) throw new HttpError(400, 'Webhook timestamp outside tolerance');
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  const ok = sigs.some((s) => { const b = Buffer.from(s, 'hex'); return b.length === expected.length && crypto.timingSafeEqual(b, expected); });
  if (!ok) throw new HttpError(400, 'Webhook signature mismatch');
  return JSON.parse(rawBody);
}

export function signWebhook(rawBody, secret, t = Math.floor(Date.now() / 1000)) {
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return `t=${t},v1=${sig}`;
}

// Map a Stripe price id back to our plan + interval
export function planForPrice(priceId) {
  for (const [plan, byInterval] of Object.entries(config.stripePrices)) {
    for (const [interval, id] of Object.entries(byInterval)) if (id && id === priceId) return { plan, interval };
  }
  return null;
}
