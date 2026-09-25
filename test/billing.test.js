// Billing (Stripe mode) end to end, against a local mock of the Stripe API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// ---- Mock Stripe
const calls = []; const subs = new Map();
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const params = Object.fromEntries(new URLSearchParams(body));
    calls.push({ method: req.method, path: req.url, params, auth: req.headers.authorization, idem: req.headers['idempotency-key'] });
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const m = req.url.match(/^\/v1\/subscriptions\/([^?]+)/);
    if (req.method === 'POST' && req.url === '/v1/checkout/sessions') return send(200, { id: 'cs_test_1', url: 'https://checkout.stripe.test/cs_test_1' });
    if (req.method === 'POST' && req.url === '/v1/billing_portal/sessions') return send(200, { url: 'https://billing.stripe.test/p/1' });
    if (m && req.method === 'GET') return subs.has(m[1]) ? send(200, subs.get(m[1])) : send(404, { error: { message: 'No such subscription' } });
    if (m && req.method === 'POST') {
      const s = subs.get(m[1]); s.items.data[0].quantity = parseInt(params['items[0][quantity]'], 10); return send(200, s);
    }
    send(404, { error: { message: 'not mocked' } });
  });
});
await new Promise((r) => mock.listen(0, r));

const WH = 'whsec_test_secret';
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgres://postgres:devpass@127.0.0.1:5432/itsm_test',
  NODE_ENV: 'test', STRIPE_SECRET_KEY: 'sk_test_123', STRIPE_WEBHOOK_SECRET: WH, STRIPE_API_BASE: `http://127.0.0.1:${mock.address().port}`,
  STRIPE_PRICE_STARTER_MONTHLY: 'price_starter_m', STRIPE_PRICE_STARTER_ANNUAL: 'price_starter_y',
  STRIPE_PRICE_PRO_MONTHLY: 'price_pro_m', STRIPE_PRICE_PRO_ANNUAL: 'price_pro_y', APP_URL: 'https://desk.aventratech.test',
});

const { pool } = await import('../src/db/index.js');
const { migrate } = await import('../src/db/migrate.js');
const { buildApp } = await import('../src/server.js');
const { signWebhook } = await import('../src/lib/stripe.js');
const { invalidateBilling } = await import('../src/lib/plans.js');

let server; let base;
function client() {
  let cookie = '';
  return async (method, path, body, headers = {}) => {
    const h = { 'x-requested-with': 'itsm', ...headers };
    if (cookie) h.cookie = cookie;
    if (body !== undefined) h['content-type'] = 'application/json';
    const r = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data };
  };
}
async function webhook(event, secret = WH) {
  const raw = JSON.stringify(event);
  return client()('POST', '/api/billing/webhook', raw, { 'stripe-signature': signWebhook(raw, secret) });
}
const subscription = (id, tenantId, price, quantity, status = 'active') => ({
  id, object: 'subscription', customer: 'cus_1', status, cancel_at_period_end: false, metadata: { tenant_id: String(tenantId) },
  items: { data: [{ id: 'si_1', price: { id: price }, quantity, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400 }] },
});

let admin; let tenantId;
before(async () => {
  const c = await pool.connect(); await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); c.release();
  await migrate({ log: () => {} });
  server = http.createServer(buildApp()); await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = client();
  const r = await admin('POST', '/api/auth/signup', { organization: 'Paying MSP', name: 'Owner', email: 'owner@paying.test', password: 'Sup3rSecret99' });
  assert.equal(r.status, 201); tenantId = r.data.tenant.id;
});
after(async () => { server?.close(); mock.close(); await pool.end(); });

test('public plan catalog', async () => {
  const r = await client()('GET', '/api/billing/plans');
  assert.equal(r.status, 200);
  assert.equal(r.data.mode, 'stripe');
  assert.deepEqual(r.data.plans.map((p) => [p.id, p.monthly]), [['starter', 29], ['pro', 59]]);
  assert.equal(r.data.plans[1].annualPerMonth, 49.17);
});

test('new workspace starts a 14-day Pro trial with a 10-seat cap', async () => {
  const me = (await admin('GET', '/api/auth/me')).data;
  assert.equal(me.billing.status, 'trialing'); assert.equal(me.billing.trialDaysLeft, 14);
  assert.ok(me.billing.features.includes('cmdb'));
  for (let i = 1; i <= 9; i++) assert.equal((await admin('POST', '/api/users', { name: `Agent ${i}`, email: `a${i}@paying.test`, role: 'agent' })).status, 201);
  const over = await admin('POST', '/api/users', { name: 'Agent 10', email: 'a10@paying.test', role: 'agent' });
  assert.equal(over.status, 402); assert.equal(over.data.details.code, 'seat_limit');
  assert.equal((await admin('POST', '/api/users', { name: 'Req', email: 'req@paying.test', role: 'requester' })).status, 201, 'requesters are free');
  const req = (await admin('GET', '/api/users?role=requester')).data[0];
  assert.equal((await admin('PATCH', `/api/users/${req.id}`, { role: 'agent' })).status, 402, 'promotion needs a seat');
});

test('checkout creates a Stripe session that carries the remaining trial and current seat count', async () => {
  const r = await admin('POST', '/api/billing/checkout', { plan: 'pro', interval: 'month' });
  assert.equal(r.status, 200); assert.equal(r.data.url, 'https://checkout.stripe.test/cs_test_1');
  const c = calls.find((x) => x.path === '/v1/checkout/sessions');
  assert.equal(c.auth, 'Bearer sk_test_123');
  assert.ok(c.idem);
  assert.equal(c.params['line_items[0][price]'], 'price_pro_m');
  assert.equal(c.params['line_items[0][quantity]'], '10');
  assert.equal(c.params['subscription_data[metadata][tenant_id]'], String(tenantId));
  assert.ok(parseInt(c.params['subscription_data[trial_end]'], 10) > Date.now() / 1000 + 13 * 86400);
  assert.equal(c.params.customer_email, 'owner@paying.test');
  assert.match(c.params.success_url, /^https:\/\/desk\.aventratech\.test\/#\/admin\/billing/);
});

test('webhooks: signature enforced, checkout completes the subscription, events are idempotent', async () => {
  const bad = await webhook({ id: 'evt_bad', type: 'invoice.paid', data: { object: {} } }, 'wrong_secret');
  assert.equal(bad.status, 400);
  subs.set('sub_1', subscription('sub_1', tenantId, 'price_pro_m', 12));
  const evt = { id: 'evt_1', type: 'checkout.session.completed', data: { object: { client_reference_id: String(tenantId), customer: 'cus_1', subscription: 'sub_1' } } };
  const ok = await webhook(evt);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const b = (await admin('GET', '/api/billing')).data;
  assert.equal(b.plan, 'pro'); assert.equal(b.status, 'active'); assert.equal(b.seats, 12); assert.equal(b.hasSubscription, true);
  assert.equal((await webhook(evt)).data.duplicate, true);
  assert.equal((await admin('POST', '/api/users', { name: 'Agent 10', email: 'a10@paying.test', role: 'agent' })).status, 201, 'paid seats apply');
  assert.equal((await admin('POST', '/api/billing/checkout', { plan: 'pro', interval: 'month' })).status, 400, 'no double subscription');
});

test('downgrade to Starter gates Pro features', async () => {
  const s = subscription('sub_1', tenantId, 'price_starter_m', 12);
  subs.set('sub_1', s);
  await webhook({ id: 'evt_2', type: 'customer.subscription.updated', data: { object: s } });
  const me = (await admin('GET', '/api/auth/me')).data;
  assert.equal(me.billing.plan, 'starter'); assert.ok(!me.billing.features.includes('cmdb'));
  const cis = await admin('GET', '/api/cis');
  assert.equal(cis.status, 402); assert.equal(cis.data.details.code, 'upgrade_required');
  assert.equal((await admin('POST', '/api/tickets', { type: 'change', title: 'x' })).status, 402);
  assert.equal((await admin('GET', '/api/tickets?type=problem')).status, 402);
  assert.equal((await admin('GET', '/api/reports')).status, 402);
  const inc = await admin('POST', '/api/tickets', { type: 'incident', title: 'Starter still does incidents' });
  assert.equal(inc.status, 201);
  assert.equal((await admin('POST', `/api/tickets/${inc.data.id}/ai/draft`)).status, 402);
});

test('seat changes go through Stripe and cannot drop below usage', async () => {
  assert.equal((await admin('POST', '/api/billing/seats', { seats: 5 })).status, 400);
  const r = await admin('POST', '/api/billing/seats', { seats: 15 });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.seats, 15);
  const c = calls.filter((x) => x.method === 'POST' && x.path === '/v1/subscriptions/sub_1').at(-1);
  assert.equal(c.params['items[0][quantity]'], '15'); assert.equal(c.params.proration_behavior, 'create_prorations');
  assert.equal((await admin('POST', '/api/billing/portal')).data.url, 'https://billing.stripe.test/p/1');
});

test('failed payment: 7-day grace, then read-only (reads, billing and sign-in still work)', async () => {
  await webhook({ id: 'evt_3', type: 'invoice.payment_failed', data: { object: { customer: 'cus_1' } } });
  let me = (await admin('GET', '/api/auth/me')).data;
  assert.equal(me.billing.status, 'past_due'); assert.equal(me.billing.readOnly, false); assert.match(me.billing.message, /7 days/);
  await pool.query(`UPDATE tenants SET past_due_since = now() - interval '8 days' WHERE id=$1`, [tenantId]); invalidateBilling(tenantId);
  me = (await admin('GET', '/api/auth/me')).data;
  assert.equal(me.billing.readOnly, true);
  const blocked = await admin('POST', '/api/tickets', { type: 'incident', title: 'x' });
  assert.equal(blocked.status, 402); assert.equal(blocked.data.details.code, 'subscription_required');
  assert.equal((await admin('GET', '/api/tickets')).status, 200);
  assert.equal((await admin('POST', '/api/billing/portal')).status, 200, 'can still fix billing');
  await webhook({ id: 'evt_4', type: 'invoice.paid', data: { object: { customer: 'cus_1' } } });
  me = (await admin('GET', '/api/auth/me')).data;
  assert.equal(me.billing.status, 'active'); assert.equal(me.billing.readOnly, false);
});

test('cancellation after the trial locks the workspace; an expired trial does too', async () => {
  await pool.query(`UPDATE tenants SET trial_ends_at = now() - interval '1 day' WHERE id=$1`, [tenantId]);
  const s = { ...subscription('sub_1', tenantId, 'price_starter_m', 15, 'canceled') };
  await webhook({ id: 'evt_5', type: 'customer.subscription.deleted', data: { object: s } });
  const me = (await admin('GET', '/api/auth/me')).data;
  assert.equal(me.billing.status, 'canceled'); assert.equal(me.billing.readOnly, true);
  assert.match(me.billing.message, /subscription has ended/);

  const fresh = client();
  const r = await fresh('POST', '/api/auth/signup', { organization: 'Late Trial', name: 'X', email: 'x@late.test', password: 'Sup3rSecret99' });
  await pool.query(`UPDATE tenants SET trial_ends_at = now() - interval '1 minute' WHERE id=$1`, [r.data.tenant.id]);
  invalidateBilling(r.data.tenant.id);
  const m2 = (await fresh('GET', '/api/auth/me')).data;
  assert.equal(m2.billing.readOnly, true); assert.match(m2.billing.message, /trial has ended/);
  assert.equal((await fresh('POST', '/api/tickets', { type: 'incident', title: 'x' })).status, 402);
});

test('comped workspaces are never locked', async () => {
  await pool.query(`UPDATE tenants SET billing_status='comped', seats=0 WHERE id=$1`, [tenantId]); invalidateBilling(tenantId);
  const me = (await admin('GET', '/api/auth/me')).data;
  assert.equal(me.billing.readOnly, false); assert.ok(me.billing.features.includes('cmdb'));
  assert.equal((await admin('POST', '/api/tickets', { type: 'change', title: 'ok' })).status, 201);
});
