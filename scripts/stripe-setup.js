#!/usr/bin/env node
// One-time Stripe setup for Aventra ITSM. Safe to re-run (finds existing objects by lookup key / URL).
//
//   STRIPE_SECRET_KEY=sk_live_... APP_URL=https://desk.aventratech.org node scripts/stripe-setup.js
//
// Creates: 2 products (Starter, Pro), 4 per-seat prices (monthly + yearly), the webhook endpoint,
// and a Customer Portal configuration (update payment method, change plan/seats, cancel, invoices).
// Prints the environment variables to paste into Railway.
const key = process.env.STRIPE_SECRET_KEY;
const appUrl = (process.env.APP_URL || '').replace(/\/$/, '');
const base = process.env.STRIPE_API_BASE || 'https://api.stripe.com';
const PRICES = { starter: Math.round(parseFloat(process.env.PRICE_STARTER || '29') * 100), pro: Math.round(parseFloat(process.env.PRICE_PRO || '59') * 100) };
if (!key || !appUrl) { console.error('Set STRIPE_SECRET_KEY and APP_URL (e.g. https://desk.aventratech.org)'); process.exit(1); }
if (!appUrl.startsWith('https://')) console.warn('⚠ APP_URL should be https:// for a live webhook endpoint.');

function form(obj, prefix, out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const kk = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => (typeof x === 'object' ? form(x, `${kk}[${i}]`, out) : out.push(`${encodeURIComponent(`${kk}[${i}]`)}=${encodeURIComponent(x)}`)));
    else if (typeof v === 'object') form(v, kk, out);
    else out.push(`${encodeURIComponent(kk)}=${encodeURIComponent(v)}`);
  }
  return out.join('&');
}
async function api(method, path, params) {
  const url = `${base}/v1/${path}${method === 'GET' && params ? `?${form(params)}` : ''}`;
  const r = await fetch(url, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/x-www-form-urlencoded' }, body: method === 'GET' ? undefined : form(params || {}) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${path}: ${j.error?.message}`);
  return j;
}

const mode = key.startsWith('sk_live') ? 'LIVE' : 'TEST';
console.log(`Stripe ${mode} mode → ${appUrl}\n`);

const env = {};
const productIds = {};
for (const [plan, name] of [['starter', 'Aventra ITSM Starter'], ['pro', 'Aventra ITSM Pro']]) {
  for (const [interval, suffix, amount] of [['month', 'monthly', PRICES[plan]], ['year', 'annual', PRICES[plan] * 10]]) {
    const lookup = `aventra_itsm_${plan}_${suffix}`;
    const found = await api('GET', 'prices', { lookup_keys: [lookup], expand: ['data.product'] });
    let price = found.data[0];
    if (price && price.unit_amount !== amount) {
      console.log(`  ${lookup}: amount changed (${price.unit_amount} → ${amount}); creating a new price and moving the lookup key`);
      price = null;
    }
    if (!price) {
      productIds[plan] ||= (found.data[0]?.product?.id) || (await api('POST', 'products', {
        name, description: plan === 'pro' ? 'Full ITSM: incidents, requests, problems, changes, CMDB, AI assist, reports, self-healing' : 'Incidents, requests, portal, catalog, knowledge base, SLAs, CSAT',
        metadata: { app: 'aventra-itsm', plan }, tax_code: 'txcd_10103001', // SaaS - business use
      })).id;
      price = await api('POST', 'prices', {
        product: productIds[plan], currency: 'usd', unit_amount: amount, recurring: { interval, usage_type: 'licensed' },
        lookup_key: lookup, transfer_lookup_key: 'true', nickname: `${name} (${suffix}, per technician)`, tax_behavior: 'exclusive',
        metadata: { app: 'aventra-itsm', plan, interval },
      });
      console.log(`  created ${lookup}: ${price.id}`);
    } else {
      productIds[plan] = price.product.id || price.product;
      console.log(`  exists  ${lookup}: ${price.id}`);
    }
    env[`STRIPE_PRICE_${plan.toUpperCase()}_${suffix.toUpperCase()}`] = price.id;
  }
}

// Webhook endpoint
const hookUrl = `${appUrl}/api/billing/webhook`;
const events = ['checkout.session.completed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.paid', 'invoice.payment_failed'];
const hooks = await api('GET', 'webhook_endpoints', { limit: 100 });
let hook = hooks.data.find((h) => h.url === hookUrl);
if (hook) {
  await api('POST', `webhook_endpoints/${hook.id}`, { enabled_events: events });
  console.log(`\n  webhook exists: ${hook.id} (events updated). Its signing secret is in the Stripe dashboard → Developers → Webhooks.`);
} else {
  hook = await api('POST', 'webhook_endpoints', { url: hookUrl, enabled_events: events, description: 'Aventra ITSM billing' });
  env.STRIPE_WEBHOOK_SECRET = hook.secret;
  console.log(`\n  created webhook ${hook.id} → ${hookUrl}`);
}

// Customer Portal: let customers manage payment methods, invoices, seats/plan and cancellation themselves
const portal = await api('POST', 'billing_portal/configurations', {
  business_profile: { headline: 'Manage your Aventra ITSM subscription' },
  default_return_url: `${appUrl}/#/admin/billing`,
  features: {
    customer_update: { enabled: 'true', allowed_updates: ['email', 'address', 'tax_id', 'name'] },
    invoice_history: { enabled: 'true' },
    payment_method_update: { enabled: 'true' },
    subscription_cancel: { enabled: 'true', mode: 'at_period_end', cancellation_reason: { enabled: 'true', options: ['too_expensive', 'missing_features', 'switched_service', 'unused', 'other'] } },
    subscription_update: {
      enabled: 'true', default_allowed_updates: ['price', 'quantity'], proration_behavior: 'create_prorations',
      products: [{ product: productIds.starter, prices: [env.STRIPE_PRICE_STARTER_MONTHLY, env.STRIPE_PRICE_STARTER_ANNUAL] },
        { product: productIds.pro, prices: [env.STRIPE_PRICE_PRO_MONTHLY, env.STRIPE_PRICE_PRO_ANNUAL] }],
    },
  },
});
await api('POST', `billing_portal/configurations/${portal.id}`, { active: 'true' });
console.log(`  customer portal configuration: ${portal.id}`);

console.log('\n==== Add these to Railway → your service → Variables ====');
console.log(`STRIPE_SECRET_KEY=${key.slice(0, 8)}…  (the key you used)`);
for (const [k, v] of Object.entries(env)) console.log(`${k}=${v}`);
console.log(`PRICE_STARTER=${PRICES.starter / 100}\nPRICE_PRO=${PRICES.pro / 100}`);
if (!env.STRIPE_WEBHOOK_SECRET) console.log('STRIPE_WEBHOOK_SECRET=<copy from Stripe dashboard → Webhooks → your endpoint → Signing secret>');
console.log('\nOptional: STRIPE_AUTOMATIC_TAX=true once Stripe Tax is activated in your dashboard.');
