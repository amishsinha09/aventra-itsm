// On-prem licensing (BILLING_MODE=license) with a throwaway Ed25519 key pair.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const priv = privateKey.export({ type: 'pkcs8', format: 'pem' });
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgres://postgres:devpass@127.0.0.1:5432/itsm_test',
  NODE_ENV: 'test', ITSM_EDITION: 'onprem', ALLOW_SIGNUP: 'first',
  LICENSE_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }),
});
const { pool } = await import('../src/db/index.js');
const { migrate } = await import('../src/db/migrate.js');
const { buildApp } = await import('../src/server.js');
const { signLicense } = await import('../src/lib/license.js');
const { invalidateBilling } = await import('../src/lib/plans.js');

let server; let base; let cookie = ''; let tenantId;
const call = async (method, path, body) => {
  const h = { 'x-requested-with': 'itsm', ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) };
  const r = await fetch(base + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
  return { status: r.status, data: await r.json() };
};
const lic = (over = {}) => signLicense({ id: 'lic-1', licensee: 'Acme Dental', email: 'it@acme.test', plan: 'pro', seats: 3,
  issued: new Date().toISOString(), expires: new Date(Date.now() + 365 * 86400000).toISOString(), ...over }, priv);

before(async () => {
  const c = await pool.connect(); await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); c.release();
  await migrate({ log: () => {} });
  server = http.createServer(buildApp()); await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await call('POST', '/api/auth/signup', { organization: 'OnPrem Co', name: 'Admin', email: 'admin@onprem.test', password: 'Sup3rSecret99' });
  assert.equal(r.status, 201); tenantId = r.data.tenant.id;
});
after(async () => { server?.close(); await pool.end(); });

test('fresh on-prem install runs a 30-day trial', async () => {
  const me = (await call('GET', '/api/auth/me')).data;
  assert.equal(me.billing.mode, 'license'); assert.equal(me.billing.status, 'trialing'); assert.equal(me.billing.trialDaysLeft, 30);
});

test('bad, tampered and expired keys are rejected', async () => {
  assert.equal((await call('POST', '/api/license', { key: 'hello' })).status, 400);
  const good = lic();
  const [v, body, sig] = good.split('.');
  const tampered = JSON.parse(Buffer.from(body, 'base64url')); tampered.seats = 999;
  const r = await call('POST', '/api/license', { key: `${v}.${Buffer.from(JSON.stringify(tampered)).toString('base64url')}.${sig}` });
  assert.equal(r.status, 400); assert.match(r.data.error, /signature/);
  const other = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.equal((await call('POST', '/api/license', { key: signLicense({ licensee: 'x', plan: 'pro', seats: 5, expires: '2099-01-01' }, other) })).status, 400, 'foreign signer');
  assert.equal((await call('POST', '/api/license', { key: lic({ expires: '2020-01-01T00:00:00Z' }) })).status, 400);
});

test('valid license sets plan and seats; expiry has a 14-day grace then read-only', async () => {
  const r = await call('POST', '/api/license', { key: lic() });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.licensee, 'Acme Dental'); assert.equal(r.data.seats, 3); assert.equal(r.data.status, 'active');
  assert.equal((await call('POST', '/api/users', { name: 'A', email: 'a@onprem.test', role: 'agent' })).status, 201);
  assert.equal((await call('POST', '/api/users', { name: 'B', email: 'b@onprem.test', role: 'agent' })).status, 201);
  assert.equal((await call('POST', '/api/users', { name: 'C', email: 'c@onprem.test', role: 'agent' })).status, 402, 'licensed seats enforced');

  await pool.query('UPDATE tenants SET license_key=$2 WHERE id=$1', [tenantId, lic({ expires: new Date(Date.now() - 3 * 86400000).toISOString() })]);
  invalidateBilling(tenantId);
  let me = (await call('GET', '/api/auth/me')).data;
  assert.equal(me.billing.status, 'past_due'); assert.equal(me.billing.readOnly, false);
  await pool.query('UPDATE tenants SET license_key=$2 WHERE id=$1', [tenantId, lic({ expires: new Date(Date.now() - 20 * 86400000).toISOString() })]);
  invalidateBilling(tenantId);
  me = (await call('GET', '/api/auth/me')).data;
  assert.equal(me.billing.readOnly, true);
  assert.equal((await call('POST', '/api/tickets', { type: 'incident', title: 'x' })).status, 402);
  assert.equal((await call('POST', '/api/license', { key: lic() })).status, 200, 'renewal works while read-only');
  assert.equal((await call('POST', '/api/tickets', { type: 'incident', title: 'x' })).status, 201);
});

test('trial ends after 30 days without a license', async () => {
  await pool.query(`UPDATE tenants SET license_key=NULL, created_at = now() - interval '31 days' WHERE id=$1`, [tenantId]);
  invalidateBilling(tenantId);
  const me = (await call('GET', '/api/auth/me')).data;
  assert.equal(me.billing.readOnly, true); assert.match(me.billing.message, /30-day trial/);
});
