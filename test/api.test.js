// End-to-end API tests against a real PostgreSQL database.
// Uses TEST_DATABASE_URL (default: local itsm_test). The schema is wiped and re-migrated on each run.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres:devpass@127.0.0.1:5432/itsm_test';
process.env.NODE_ENV = 'test';

const { pool } = await import('../src/db/index.js');
const { migrate } = await import('../src/db/migrate.js');
const { buildApp } = await import('../src/server.js');
const { slaSweep } = await import('../src/lib/slaJob.js');

let server; let base;

// Minimal client that keeps cookies per "browser"
function client(opts = {}) {
  let cookie = '';
  return async function call(method, path, body, headers = {}) {
    const h = { ...headers };
    if (cookie && !opts.noCookie) h.cookie = cookie;
    if (body !== undefined) h['content-type'] = 'application/json';
    if (!opts.noCsrf) h['x-requested-with'] = 'itsm';
    if (opts.apiKey) h['x-api-key'] = opts.apiKey;
    const r = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data };
  };
}

async function signup(org, email) {
  const c = client();
  const r = await c('POST', '/api/auth/signup', { organization: org, name: 'Admin ' + org, email, password: 'Sup3rSecret99' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return { c, tenant: r.data.tenant, user: r.data.user };
}
async function login(email, password = 'Sup3rSecret99') {
  const c = client();
  const r = await c('POST', '/api/auth/login', { email, password });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return c;
}

let A; let B; let reqA; let agentA; let apiKeyA; let companyA;

before(async () => {
  const c = await pool.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  c.release();
  await migrate({ log: () => {} });
  server = http.createServer(buildApp());
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;

  A = await signup('Alpha MSP', 'admin@alpha.test');
  B = await signup('Beta MSP', 'admin@beta.test');
  companyA = (await A.c('POST', '/api/companies', { name: 'Acme', domain: 'acme.test' })).data;
  assert.ok(companyA.id);
  const ag = await A.c('POST', '/api/users', { name: 'Agent Alpha', email: 'agent@alpha.test', role: 'agent', password: 'Sup3rSecret99' });
  assert.equal(ag.status, 201, JSON.stringify(ag.data));
  const rq = await A.c('POST', '/api/users', { name: 'Req Alpha', email: 'req@acme.test', role: 'requester', company_id: companyA.id, password: 'Sup3rSecret99' });
  assert.equal(rq.status, 201);
  agentA = await login('agent@alpha.test');
  reqA = await login('req@acme.test');
  const k = await A.c('POST', '/api/api-keys', { name: 'agent' });
  apiKeyA = k.data.key;
  assert.match(apiKeyA, /^avk_/);
});

after(async () => { server?.close(); await pool.end(); });

test('health and auth basics', async () => {
  const c = client();
  assert.equal((await c('GET', '/api/health')).status, 200);
  assert.equal((await c('GET', '/api/tickets')).status, 401);
  assert.equal((await c('POST', '/api/auth/login', { email: 'admin@alpha.test', password: 'wrongpass123' })).status, 401);
  const me = await A.c('GET', '/api/auth/me');
  assert.equal(me.data.user.role, 'admin');
  assert.equal(me.data.timezone, 'America/Chicago');
  const weak = await client()('POST', '/api/auth/signup', { organization: 'X', name: 'X', email: 'x@x.test', password: 'short' });
  assert.equal(weak.status, 400);
});

test('CSRF: cookie-authenticated mutation without header is rejected', async () => {
  const c = client({ noCsrf: true });
  await c('POST', '/api/auth/login', { email: 'agent@alpha.test', password: 'Sup3rSecret99' });
  const r = await c('POST', '/api/tickets', { type: 'incident', title: 'x' });
  assert.equal(r.status, 403);
});

test('incident: priority matrix, SLA targets, auto-routing, resolution rules', async () => {
  const r = await agentA('POST', '/api/tickets', { type: 'incident', title: 'VPN down for all users', impact: 1, urgency: 1 });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const t = r.data;
  assert.equal(t.priority, 1);
  assert.match(t.number, /^INC\d{7}$/);
  assert.ok(t.response_due && t.resolve_due);
  assert.equal(Math.round((new Date(t.resolve_due) - new Date(t.created_at)) / 60000), 240); // default P1 = 4h
  assert.equal(t.category, 'Network');
  assert.equal(t.group_name, 'Infrastructure'); // routed by category

  const bad = await agentA('PATCH', `/api/tickets/${t.id}`, { status: 'resolved' });
  assert.equal(bad.status, 400);
  const bad2 = await agentA('PATCH', `/api/tickets/${t.id}`, { status: 'closed' });
  assert.equal(bad2.status, 400); // new -> closed is not a valid transition
  const ok = await agentA('PATCH', `/api/tickets/${t.id}`, { status: 'resolved', resolution_code: 'workaround', resolution_notes: 'Restarted VPN concentrator' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.ok(ok.data.resolved_at);
  const reopened = await agentA('PATCH', `/api/tickets/${t.id}`, { status: 'in_progress' });
  assert.equal(reopened.data.resolved_at, null);
});

test('SLA clock pauses on hold and resumes', async () => {
  const t = (await agentA('POST', '/api/tickets', { type: 'incident', title: 'Printer offline' })).data;
  const held = (await agentA('PATCH', `/api/tickets/${t.id}`, { status: 'on_hold' })).data;
  assert.ok(held.sla_paused_at);
  await new Promise((r) => setTimeout(r, 1100));
  const resumed = (await agentA('PATCH', `/api/tickets/${t.id}`, { status: 'in_progress' })).data;
  assert.equal(resumed.sla_paused_at, null);
  assert.ok(new Date(resumed.resolve_due) - new Date(t.resolve_due) >= 1000, 'due date shifted by paused time');
});

test('SLA sweep flags breaches', async () => {
  const t = (await agentA('POST', '/api/tickets', { type: 'incident', title: 'Old ticket' })).data;
  await pool.query(`UPDATE tickets SET resolve_due = now() - interval '1 minute' WHERE id = $1`, [t.id]);
  const r = await slaSweep();
  assert.ok(r.breached >= 1);
  const d = (await agentA('GET', `/api/tickets/${t.id}`)).data;
  assert.equal(d.ticket.sla_breached, true);
  assert.ok(d.events.some((e) => e.kind === 'sla'));
});

test('requester restrictions: own tickets only, no routing, no internal notes', async () => {
  const mine = await reqA('POST', '/api/tickets', { type: 'incident', title: 'My laptop is slow', assignee_id: 1, category: 'Security' });
  assert.equal(mine.status, 201);
  assert.equal(mine.data.assignee_id, null);
  assert.notEqual(mine.data.category, 'Security');
  assert.equal(mine.data.company_id, companyA.id);
  assert.equal((await reqA('POST', '/api/tickets', { type: 'change', title: 'x' })).status, 403);

  const other = (await agentA('POST', '/api/tickets', { type: 'incident', title: 'Someone else' })).data;
  assert.equal((await reqA('GET', `/api/tickets/${other.id}`)).status, 404);
  const list = (await reqA('GET', '/api/tickets')).data;
  assert.ok(list.rows.every((t) => t.requester_id === mine.data.requester_id));

  await agentA('POST', `/api/tickets/${mine.data.id}/comments`, { body: 'secret triage note', internal: true });
  await agentA('POST', `/api/tickets/${mine.data.id}/comments`, { body: 'Hi, looking now', internal: false });
  const view = (await reqA('GET', `/api/tickets/${mine.data.id}`)).data;
  assert.equal(view.comments.length, 1);
  assert.equal(view.comments[0].body, 'Hi, looking now');
  assert.equal(view.events.length, 0);

  assert.equal((await reqA('PATCH', `/api/tickets/${mine.data.id}`, { assignee_id: 2 })).status, 403);
  assert.equal((await reqA('GET', '/api/cis')).status, 403);
  assert.equal((await reqA('GET', '/api/users')).status, 403);
  const cancel = await reqA('PATCH', `/api/tickets/${mine.data.id}`, { status: 'canceled' });
  assert.equal(cancel.status, 200);
});

test('tenant isolation', async () => {
  const t = (await A.c('POST', '/api/tickets', { type: 'incident', title: 'Alpha only' })).data;
  const ci = (await A.c('POST', '/api/cis', { name: 'ALPHA-SRV1', ci_class: 'server' })).data;
  assert.equal((await B.c('GET', `/api/tickets/${t.id}`)).status, 404);
  assert.equal((await B.c('PATCH', `/api/tickets/${t.id}`, { title: 'hijack' })).status, 404);
  assert.equal((await B.c('GET', `/api/cis/${ci.id}`)).status, 404);
  const cross = await B.c('POST', '/api/tickets', { type: 'incident', title: 'x', ci_id: ci.id });
  assert.equal(cross.status, 400, 'cannot reference another tenant\'s CI');
  const bl = (await B.c('GET', '/api/tickets')).data;
  assert.ok(bl.rows.every((r) => r.tenant_id === B.tenant.id));
  assert.equal((await B.c('POST', `/api/tickets/${t.id}/comments`, { body: 'x' })).status, 404);
});

test('change management: risk, CAB approval, conflicts, standard change', async () => {
  const ci = (await A.c('POST', '/api/cis', { name: 'CORE-SW1', ci_class: 'network', criticality: 1 })).data;
  const start = new Date(Date.now() + 86400000).toISOString(); const end = new Date(Date.now() + 90000000).toISOString();
  const chg = (await agentA('POST', '/api/tickets', { type: 'change', title: 'Upgrade core switch', ci_id: ci.id, details: { change_type: 'normal', planned_start: start, planned_end: end } })).data;
  assert.equal(chg.status, 'draft');
  assert.equal(chg.details.risk, 'high'); // criticality 1, no backout/test plan
  await agentA('PATCH', `/api/tickets/${chg.id}`, { status: 'assess' });
  assert.equal((await agentA('PATCH', `/api/tickets/${chg.id}`, { status: 'scheduled' })).status, 400, 'normal change cannot skip CAB');
  const pend = await agentA('PATCH', `/api/tickets/${chg.id}`, { status: 'pending_approval' });
  assert.equal(pend.status, 200, JSON.stringify(pend.data));

  const d = (await A.c('GET', `/api/tickets/${chg.id}`)).data;
  assert.equal(d.approvals.length, 1); // CAB = the admin
  const mine = (await A.c('GET', '/api/approvals')).data;
  const ap = mine.find((a) => a.ticket_id === chg.id);
  assert.ok(ap);
  assert.equal((await agentA('POST', `/api/approvals/${ap.id}`, { decision: 'approved' })).status, 403, 'not your approval');
  assert.equal((await A.c('POST', `/api/approvals/${ap.id}`, { decision: 'rejected' })).status, 400, 'reject needs reason');
  const dec = await A.c('POST', `/api/approvals/${ap.id}`, { decision: 'approved', comment: 'ok' });
  assert.equal(dec.data.outcome, 'approved');
  assert.equal((await A.c('GET', `/api/tickets/${chg.id}`)).data.ticket.status, 'scheduled');

  // Standard change on same CI & window: allowed to skip CAB, and shows a conflict
  const std = (await agentA('POST', '/api/tickets', { type: 'change', title: 'Std change', ci_id: ci.id, details: { change_type: 'standard', planned_start: start, planned_end: end, backout_plan: 'x', test_plan: 'y' } })).data;
  await agentA('PATCH', `/api/tickets/${std.id}`, { status: 'assess' });
  const s = await agentA('PATCH', `/api/tickets/${std.id}`, { status: 'scheduled' });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  const sd = (await agentA('GET', `/api/tickets/${std.id}`)).data;
  assert.equal(sd.conflicts.length, 1);
  assert.equal(sd.conflicts[0].id, chg.id);
});

test('service request with catalog approval', async () => {
  const items = (await reqA('GET', '/api/catalog')).data;
  const laptop = items.find((i) => i.name === 'New laptop');
  assert.ok(laptop.approval_required);
  const missing = await reqA('POST', '/api/tickets', { type: 'request', catalog_item_id: laptop.id, details: { variables: { model: 'MacBook Pro' } } });
  assert.equal(missing.status, 400, 'required variable enforced');
  const r = await reqA('POST', '/api/tickets', { type: 'request', catalog_item_id: laptop.id, details: { variables: { model: 'MacBook Pro', reason: 'Old one broke' } } });
  assert.equal(r.status, 201);
  assert.equal(r.data.status, 'pending_approval');
  assert.equal(r.data.title, 'New laptop');
  const ap = (await A.c('GET', '/api/approvals')).data.find((a) => a.ticket_id === r.data.id);
  const out = await A.c('POST', `/api/approvals/${ap.id}`, { decision: 'approved' });
  assert.equal(out.data.outcome, 'approved');
  const t = (await agentA('GET', `/api/tickets/${r.data.id}`)).data.ticket;
  assert.equal(t.status, 'approved');
  assert.equal(t.sla_paused_at, null);
});

test('problem resolution resolves linked incidents', async () => {
  const prb = (await agentA('POST', '/api/tickets', { type: 'problem', title: 'Recurring DNS failures' })).data;
  const i1 = (await agentA('POST', '/api/tickets', { type: 'incident', title: 'DNS fail 1' })).data;
  const i2 = (await agentA('POST', '/api/tickets', { type: 'incident', title: 'DNS fail 2' })).data;
  for (const i of [i1, i2]) assert.equal((await agentA('PATCH', `/api/tickets/${i.id}`, { problem_id: prb.id })).status, 200);
  await agentA('PATCH', `/api/tickets/${prb.id}`, { status: 'investigating' });
  const res = await agentA('PATCH', `/api/tickets/${prb.id}`, { status: 'resolved', resolution_code: 'solved_permanently', resolution_notes: 'Replaced DNS forwarder' });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  for (const i of [i1, i2]) {
    const t = (await agentA('GET', `/api/tickets/${i.id}`)).data.ticket;
    assert.equal(t.status, 'resolved');
    assert.match(t.resolution_notes, /PRB/);
  }
});

test('Aventra integration: open, dedupe, auto-resolve, escalate, inventory', async () => {
  const bot = client({ apiKey: apiKeyA, noCookie: true, noCsrf: true });
  assert.equal((await bot('GET', '/api/tickets')).status, 403, 'API keys limited to integration endpoints');
  assert.equal((await client({ apiKey: 'avk_nope', noCsrf: true })('POST', '/api/integrations/aventra/events', {})).status, 401);

  const open = await bot('POST', '/api/integrations/aventra/events', { event: 'alert.opened', alert_id: 'a1', hostname: 'ACME-LT-9', company: 'Acme', severity: 'high', title: 'Disk low' });
  assert.equal(open.status, 200, JSON.stringify(open.data));
  assert.equal(open.data.action, 'created');
  assert.equal(open.data.ticket.priority, 2);
  const dup = await bot('POST', '/api/integrations/aventra/events', { event: 'alert.opened', alert_id: 'a1', hostname: 'ACME-LT-9' });
  assert.equal(dup.data.action, 'deduplicated');
  assert.equal(dup.data.ticket.id, open.data.ticket.id);
  const fixed = await bot('POST', '/api/integrations/aventra/events', { event: 'remediation.succeeded', alert_id: 'a1', hostname: 'ACME-LT-9', playbook: 'disk-cleanup' });
  assert.equal(fixed.data.action, 'auto_resolved');
  const t = (await agentA('GET', `/api/tickets/${open.data.ticket.id}`)).data.ticket;
  assert.equal(t.status, 'resolved'); assert.equal(t.auto_remediated, true); assert.equal(t.resolution_code, 'auto_remediated');
  assert.equal(t.company_id, companyA.id, 'matched existing company by name');

  const fail = await bot('POST', '/api/integrations/aventra/events', { event: 'remediation.failed', alert_id: 'a2', hostname: 'ACME-SRV-2', severity: 'medium', title: 'Service stopped' });
  assert.equal(fail.data.action, 'escalated');
  const t2 = (await agentA('GET', `/api/tickets/${fail.data.ticket.id}`)).data.ticket;
  assert.equal(t2.urgency, 1); assert.equal(t2.status, 'in_progress');

  const inv = await bot('POST', '/api/integrations/aventra/inventory', { devices: [{ hostname: 'ACME-LT-9', os: 'Windows 11', ip_address: '10.0.0.9' }, { hostname: 'NEW-DEV-1', ci_class: 'server' }] });
  assert.equal(inv.data.upserted, 2);
  const cis = (await agentA('GET', '/api/cis?q=ACME-LT-9')).data;
  assert.equal(cis.length, 1); assert.equal(cis[0].os, 'Windows 11'); assert.equal(cis[0].source, 'aventra');
});

test('email to ticket: known domain creates ticket, reply adds comment, unknown sender rejected', async () => {
  const mail = client({ apiKey: apiKeyA, noCookie: true, noCsrf: true });
  const r = await mail('POST', '/api/integrations/email/inbound', { from: 'New Person <new.person@acme.test>', subject: 'Cannot print', text: 'Printer says offline' });
  assert.equal(r.data.action, 'created', JSON.stringify(r.data));
  const num = r.data.ticket.number;
  const reply = await mail('POST', '/api/integrations/email/inbound', { from: 'new.person@acme.test', subject: `Re: [${num}] Cannot print`, text: 'Still broken\n\nOn Mon, Support wrote:\n> quoted' });
  assert.equal(reply.data.action, 'commented');
  const d = (await agentA('GET', `/api/tickets/${r.data.ticket.id}`)).data;
  assert.equal(d.ticket.source, 'email');
  assert.equal(d.comments.at(-1).body, 'Still broken');
  const spam = await mail('POST', '/api/integrations/email/inbound', { from: 'spam@evil.test', subject: 'Buy now', text: 'x' });
  assert.equal(spam.data.action, 'rejected_unknown_sender');
});

test('CSAT survey: requester only, after resolution, once; reported on dashboard', async () => {
  const t = (await reqA('POST', '/api/tickets', { type: 'incident', title: 'Mouse broken' })).data;
  assert.equal((await reqA('POST', `/api/tickets/${t.id}/csat`, { score: 5 })).status, 400, 'not resolved yet');
  await agentA('PATCH', `/api/tickets/${t.id}`, { status: 'resolved', resolution_code: 'solved_permanently', resolution_notes: 'New mouse' });
  assert.equal((await agentA('POST', `/api/tickets/${t.id}/csat`, { score: 5 })).status, 404, 'only the requester rates');
  assert.equal((await reqA('POST', `/api/tickets/${t.id}/csat`, { score: 9 })).status, 400);
  const ok = await reqA('POST', `/api/tickets/${t.id}/csat`, { score: 2, comment: 'Slow' });
  assert.equal(ok.status, 200);
  assert.equal((await reqA('POST', `/api/tickets/${t.id}/csat`, { score: 5 })).status, 400, 'only once');
  const dash = (await agentA('GET', '/api/dashboard')).data;
  assert.equal(dash.csat.responses, 1); assert.equal(dash.csat.avg, 2);
  assert.equal(dash.timezone, 'America/Chicago');
  const rep = (await agentA('GET', '/api/reports?days=30')).data;
  assert.ok(rep.companies.some((c) => c.name === 'Acme' && c.csat_n === 1));
  assert.equal(rep.comments[0].csat_comment, 'Slow');
});

test('time zones: workspace default and user override are validated', async () => {
  assert.equal((await A.c('PATCH', '/api/tenant', { timezone: 'Mars/Olympus' })).status, 400);
  assert.equal((await A.c('PATCH', '/api/tenant', { timezone: 'America/New_York' })).status, 200);
  assert.equal((await agentA('GET', '/api/auth/me')).data.timezone, 'America/New_York');
  await agentA('PATCH', '/api/auth/profile', { timezone: 'America/Chicago' });
  assert.equal((await agentA('GET', '/api/auth/me')).data.timezone, 'America/Chicago');
  assert.equal((await agentA('PATCH', '/api/tenant', { timezone: 'UTC' })).status, 403, 'agents cannot change workspace');
  await A.c('PATCH', '/api/tenant', { timezone: 'America/Chicago' });
});

test('knowledge: drafts hidden from requesters, KB from resolved ticket, search', async () => {
  const draft = (await agentA('POST', '/api/kb', { title: 'Internal runbook for firewall', body: 'steps', status: 'draft' })).data;
  assert.equal((await reqA('GET', `/api/kb/${draft.id}`)).status, 404);
  const t = (await agentA('POST', '/api/tickets', { type: 'incident', title: 'Teams audio drops' })).data;
  await agentA('PATCH', `/api/tickets/${t.id}`, { status: 'resolved', resolution_code: 'solved_permanently', resolution_notes: 'Updated audio driver' });
  const kb = await agentA('POST', `/api/tickets/${t.id}/kb`);
  assert.equal(kb.status, 201);
  assert.equal(kb.data.status, 'draft'); assert.match(kb.data.body, /Updated audio driver/);
  const found = (await reqA('GET', '/api/kb?q=reset password')).data;
  assert.ok(found.some((a) => /password/i.test(a.title)));
});

test('admin-only endpoints and validation', async () => {
  assert.equal((await agentA('POST', '/api/users', { name: 'x', email: 'x@y.test', role: 'admin' })).status, 403);
  assert.equal((await agentA('GET', '/api/audit')).status, 403);
  assert.equal((await A.c('POST', '/api/users', { name: 'x', email: 'not-an-email', role: 'agent' })).status, 400);
  assert.equal((await A.c('POST', '/api/users', { name: 'dup', email: 'agent@alpha.test', role: 'agent' })).status, 409);
  assert.equal((await A.c('PATCH', `/api/users/${A.user.id}`, { role: 'agent' })).status, 403, 'cannot demote self');
  const audit = (await A.c('GET', '/api/audit')).data;
  assert.ok(audit.some((a) => a.action === 'ticket.create'));
  const csv = await agentA('GET', '/api/tickets/export.csv?type=incident');
  assert.equal(csv.status, 200);
  assert.match(csv.data, /^number,type,title/);
});

test('password reset: generic response, single-use expiring token', async () => {
  const c = client();
  const a = await c('POST', '/api/auth/forgot', { email: 'req@acme.test' });
  const b = await c('POST', '/api/auth/forgot', { email: 'nobody@nowhere.test' });
  assert.deepEqual(a.data, b.data, 'same answer whether or not the account exists');
  const { hashApiKey } = await import('../src/lib/auth.js');
  const u = (await pool.query(`SELECT id FROM users WHERE email='req@acme.test'`)).rows[0];
  assert.equal((await pool.query('SELECT count(*)::int n FROM password_resets WHERE user_id=$1 AND used_at IS NULL', [u.id])).rows[0].n, 1);
  await pool.query(`INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1,$2, now() + interval '1 hour')`, [u.id, hashApiKey('known-token')]);
  assert.equal((await c('POST', '/api/auth/reset', { token: 'known-token', password: 'short' })).status, 400);
  const ok = await c('POST', '/api/auth/reset', { token: 'known-token', password: 'BrandNewPass42' });
  assert.equal(ok.status, 200);
  assert.equal((await c('GET', '/api/auth/me')).status, 200, 'signed in after reset');
  assert.equal((await client()('POST', '/api/auth/reset', { token: 'known-token', password: 'AnotherPass42' })).status, 400, 'token is single-use');
  reqA = await login('req@acme.test', 'BrandNewPass42'); // the reset signed out older sessions
});

test('sessions are revoked on password change; requesters never see other users\' tickets in suggestions', async () => {
  const other = await login('agent@alpha.test');
  const self = await login('agent@alpha.test');
  const r = await self('POST', '/api/auth/password', { current: 'Sup3rSecret99', password: 'Sup3rSecret100' });
  assert.equal(r.status, 200);
  assert.equal((await other('GET', '/api/auth/me')).status, 401, 'other session revoked');
  assert.equal((await self('GET', '/api/auth/me')).status, 200, 'current browser gets a fresh session');
  await self('POST', '/api/auth/password', { current: 'Sup3rSecret100', password: 'Sup3rSecret99' });
  agentA = await login('agent@alpha.test');

  const t = (await reqA('POST', '/api/tickets', { type: 'incident', title: 'DNS fail again' })).data;
  const d = (await reqA('GET', `/api/tickets/${t.id}`)).data;
  assert.deepEqual(d.suggestions.similar, []);
});
