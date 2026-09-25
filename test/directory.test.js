// Active Directory (LDAP) and Microsoft Entra ID sign-in, end to end against simulated servers:
//  - a mock domain controller that speaks real LDAP v3 BER on a TCP socket (AD semantics: memberOf,
//    userAccountControl, LDAP_MATCHING_RULE_IN_CHAIN nested groups, "data 775" lockout diagnostics)
//  - a mock Entra tenant (OIDC discovery, JWKS, authorize redirect, token endpoint with PKCE + RS256 ID tokens)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import tls from 'node:tls';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres:devpass@127.0.0.1:5432/itsm_test';
process.env.NODE_ENV = 'test';

const { readTLV, tlv } = await import('../src/lib/ldap.js');

// ============================================================ mock Active Directory
const BASE = 'DC=corp,DC=local';
const G = (cn) => `CN=${cn},OU=Groups,${BASE}`;
const U = (cn) => `CN=${cn},OU=Staff,${BASE}`;
const guid = (n) => Buffer.from(crypto.createHash('md5').update(String(n)).digest());
const dir = [
  { dn: BASE, objectClass: ['domain'] },
  { dn: G('ITSM-Admins'), objectClass: ['group'], cn: 'ITSM-Admins', sAMAccountName: 'ITSM-Admins' },
  { dn: G('ITSM-Agents'), objectClass: ['group'], cn: 'ITSM-Agents', sAMAccountName: 'ITSM-Agents' },
  { dn: G('Helpdesk Leads'), objectClass: ['group'], cn: 'Helpdesk Leads', memberOf: [G('ITSM-Admins')] }, // nested in admins
  { dn: `CN=svc-itsm,OU=Service,${BASE}`, objectClass: ['user'], password: 'SvcPass1!' },
  { dn: U('Jane Doe'), objectClass: ['user'], objectCategory: 'person', sAMAccountName: 'jdoe', userPrincipalName: 'jdoe@corp.local', mail: 'jane.doe@corp.com', displayName: 'Jane Doe', memberOf: [G('ITSM-Agents')], userAccountControl: '512', objectGUID: guid(1), password: 'Winter2026!' },
  { dn: U('Ann Admin'), objectClass: ['user'], objectCategory: 'person', sAMAccountName: 'aadmin', userPrincipalName: 'aadmin@corp.local', mail: 'ann@corp.com', displayName: 'Ann Admin', memberOf: [G('Helpdesk Leads')], userAccountControl: '512', objectGUID: guid(2), password: 'Summer2026!' },
  { dn: U('Bob Builder'), objectClass: ['user'], objectCategory: 'person', sAMAccountName: 'bob', userPrincipalName: 'bob@corp.local', displayName: 'Bob Builder', userAccountControl: '512', objectGUID: guid(3), password: 'Bob2026pass' },
  { dn: U('Dee Disabled'), objectClass: ['user'], objectCategory: 'person', sAMAccountName: 'dee', mail: 'dee@corp.com', displayName: 'Dee', userAccountControl: '514', objectGUID: guid(4), password: 'Dee2026pass' },
  { dn: U('Lou Locked'), objectClass: ['user'], objectCategory: 'person', sAMAccountName: 'lou', mail: 'lou@corp.com', displayName: 'Lou', userAccountControl: '512', objectGUID: guid(5), password: 'x', locked: true },
];
const ldapLog = [];

function kids(buf) { const out = []; let o = 0; while (o < buf.length) { const t = readTLV(buf, o); out.push(t); o = t.next; } return out; }
const str = (t) => t.value.toString('utf8');
const valuesOf = (e, a) => {
  const k = Object.keys(e).find((x) => x.toLowerCase() === a.toLowerCase());
  if (!k || k === 'password' || k === 'locked') return a.toLowerCase() === 'distinguishedname' ? [e.dn] : [];
  const v = e[k]; return Array.isArray(v) ? v : [v];
};
const ieq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
function memberOfChain(e, seen = new Set()) {
  const out = [];
  for (const g of valuesOf(e, 'memberOf')) {
    if (seen.has(g.toLowerCase())) continue; seen.add(g.toLowerCase()); out.push(g);
    const ge = dir.find((x) => ieq(x.dn, g)); if (ge) out.push(...memberOfChain(ge, seen));
  }
  return out;
}
function matches(f, e) {
  switch (f.tag) {
    case 0xa0: return kids(f.value).every((c) => matches(c, e));
    case 0xa1: return kids(f.value).some((c) => matches(c, e));
    case 0xa2: return !matches(kids(f.value)[0], e);
    case 0x87: { const a = f.value.toString('utf8'); return a.toLowerCase() === 'objectclass' ? true : valuesOf(e, a).length > 0; }
    case 0xa3: { const [a, v] = kids(f.value); return valuesOf(e, str(a)).some((x) => Buffer.isBuffer(x) ? x.equals(v.value) : ieq(x, str(v))); }
    case 0xa4: {
      const [a, subs] = kids(f.value);
      return valuesOf(e, str(a)).some((val) => {
        let s = String(val).toLowerCase(); let ok = true;
        for (const p of kids(subs.value)) {
          const piece = str(p).toLowerCase();
          if (p.tag === 0x80) { ok = s.startsWith(piece); s = s.slice(piece.length); }
          else if (p.tag === 0x81) { const i = s.indexOf(piece); ok = i >= 0; s = s.slice(i + piece.length); }
          else { ok = s.endsWith(piece); }
          if (!ok) break;
        }
        return ok;
      });
    }
    case 0xa9: {
      const parts = Object.fromEntries(kids(f.value).map((p) => [p.tag, str(p)]));
      if (parts[0x81] === '1.2.840.113556.1.4.1941' && ieq(parts[0x82], 'memberOf')) return memberOfChain(e).some((g) => ieq(g, parts[0x83]));
      return false;
    }
    default: return false;
  }
}
const result = (tag, id, code, diag = '') => tlv(0x30, Buffer.concat([tlv(0x02, Buffer.from([id])), tlv(tag, Buffer.concat([tlv(0x0a, Buffer.from([code])), tlv(0x04, ''), tlv(0x04, diag)]))]));
function handleLdap(sock) {
  let buf = Buffer.alloc(0);
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      const m = readTLV(buf, 0); if (!m) return; buf = buf.subarray(m.next);
      const [idT, op] = kids(m.value); const id = idT.value[idT.value.length - 1];
      if (op.tag === 0x60) { // bind
        const [, name, auth] = kids(op.value);
        const dn = str(name); const pw = auth.value.toString('utf8');
        ldapLog.push(`bind ${dn}`);
        const e = dir.find((x) => ieq(x.dn, dn));
        if (e?.locked) sock.write(result(0x61, id, 49, '80090308: LdapErr: DSID-0C09044E, comment: AcceptSecurityContext error, data 775, v4563'));
        else if (e && e.password === pw) sock.write(result(0x61, id, 0));
        else sock.write(result(0x61, id, 49, '80090308: LdapErr: DSID-0C09044E, comment: AcceptSecurityContext error, data 52e, v4563'));
      } else if (op.tag === 0x63) { // search
        const [base, scope, , size, , , filter, attrs] = kids(op.value);
        const b = str(base); const sc = scope.value[0]; const wanted = kids(attrs.value).map(str);
        ldapLog.push(`search ${b} scope=${sc}`);
        const inScope = dir.filter((e) => (sc === 0 ? ieq(e.dn, b) : e.dn.toLowerCase().endsWith(b.toLowerCase())));
        const limit = size.value[size.value.length - 1] || Infinity;
        for (const e of inScope.filter((x) => matches(filter, x)).slice(0, limit)) {
          const attrSeqs = wanted.map((a) => {
            const vals = valuesOf(e, a); if (!vals.length) return null;
            return tlv(0x30, Buffer.concat([tlv(0x04, a), tlv(0x31, Buffer.concat(vals.map((v) => tlv(0x04, Buffer.isBuffer(v) ? v : String(v)))))]));
          }).filter(Boolean);
          sock.write(tlv(0x30, Buffer.concat([tlv(0x02, Buffer.from([id])), tlv(0x64, Buffer.concat([tlv(0x04, e.dn), tlv(0x30, Buffer.concat(attrSeqs))]))])));
        }
        sock.write(result(0x65, id, 0));
      } else if (op.tag === 0x42) sock.end();
    }
  });
  sock.on('error', () => {});
}
const ldapServer = net.createServer(handleLdap);
await new Promise((r) => ldapServer.listen(0, '127.0.0.1', r));
const LDAP_URL = `ldap://127.0.0.1:${ldapServer.address().port}`;

// ============================================================ mock Microsoft Entra
const TID = '11111111-2222-3333-4444-555555555555';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
const codes = new Map(); let idp; let IDP; let nextUser = null; const idpLog = [];
const signJwt = (claims) => {
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'k1' })).toString('base64url');
  const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${h}.${p}.${crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url')}`;
};
idp = http.createServer((req, res) => {
  const u = new URL(req.url, IDP);
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const json = (o, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.pathname === `/${TID}/v2.0/.well-known/openid-configuration`) {
      return json({ issuer: `${IDP}/{tenantid}/v2.0`, authorization_endpoint: `${IDP}/${TID}/oauth2/v2.0/authorize`, token_endpoint: `${IDP}/${TID}/oauth2/v2.0/token`, jwks_uri: `${IDP}/keys` });
    }
    if (u.pathname === '/keys') return json({ keys: [jwk] });
    if (u.pathname.endsWith('/authorize')) {
      const q = Object.fromEntries(u.searchParams);
      idpLog.push(q);
      const code = crypto.randomBytes(8).toString('hex');
      codes.set(code, { ...q, user: nextUser });
      res.writeHead(302, { location: `${q.redirect_uri}?code=${code}&state=${q.state}` }); return res.end();
    }
    if (u.pathname.endsWith('/token')) {
      const p = Object.fromEntries(new URLSearchParams(body));
      const c = codes.get(p.code); codes.delete(p.code);
      if (!c) return json({ error: 'invalid_grant', error_description: 'AADSTS70008: code expired' }, 400);
      const challenge = crypto.createHash('sha256').update(p.code_verifier || '').digest('base64url');
      if (challenge !== c.code_challenge) return json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400);
      if (p.client_secret !== 'entra-secret' || p.client_id !== c.client_id || p.redirect_uri !== c.redirect_uri) return json({ error: 'invalid_client' }, 401);
      const now = Math.floor(Date.now() / 1000);
      return json({ id_token: signJwt({ iss: `${IDP}/${TID}/v2.0`, aud: c.client_id, tid: TID, iat: now, nbf: now, exp: now + 3600, nonce: c.nonce, ...c.user }) });
    }
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => idp.listen(0, '127.0.0.1', r));
IDP = `http://127.0.0.1:${idp.address().port}`;

// ============================================================ app under test
const { pool } = await import('../src/db/index.js');
const { migrate } = await import('../src/db/migrate.js');
const { buildApp } = await import('../src/server.js');
let server; let base;
function client() {
  let jar = {};
  const call = async (method, path, body, { follow = false } = {}) => {
    const h = { 'x-requested-with': 'itsm' };
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) h.cookie = cookie;
    if (body !== undefined) h['content-type'] = 'application/json';
    const r = await fetch(path.startsWith('http') ? path : base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    for (const c of r.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const i = kv.indexOf('='); const k = kv.slice(0, i); const v = kv.slice(i + 1); if (v) jar[k] = v; else delete jar[k]; }
    const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data, location: r.headers.get('location') };
  };
  call.jar = () => jar;
  return call;
}

let admin;
before(async () => {
  const c = await pool.connect(); await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); c.release();
  await migrate({ log: () => {} });
  server = http.createServer(buildApp()); await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = client();
  const r = await admin('POST', '/api/auth/signup', { organization: 'Corp', name: 'Local Admin', email: 'root@corp.com', password: 'LocalAdmin123' });
  assert.equal(r.status, 201);
  assert.equal((await admin('PUT', '/api/access/url', { public_url: base })).status, 200);
});
after(async () => { server?.close(); ldapServer.close(); idp.close(); await pool.end(); });

const LDAP_CFG = {
  enabled: true, url: LDAP_URL, baseDN: BASE, bindDN: `CN=svc-itsm,OU=Service,${BASE}`, bindPassword: 'SvcPass1!',
  adminGroups: ['ITSM-Admins'], agentGroups: [G('ITSM-Agents')], requesterGroups: [], defaultRole: 'requester', nestedGroups: true,
};

test('admin can test and save the AD connection (secrets never returned)', async () => {
  const bad = await admin('POST', '/api/access/ldap/test', { ...LDAP_CFG, bindPassword: 'wrong' });
  assert.equal(bad.data.ok, false);
  assert.match(bad.data.steps.find((s) => !s.ok).detail, /Incorrect username or password/);
  const t = await admin('POST', '/api/access/ldap/test', { ...LDAP_CFG, testUser: 'jdoe', testPassword: 'Winter2026!' });
  assert.equal(t.data.ok, true, JSON.stringify(t.data.steps));
  assert.match(t.data.steps.at(-1).detail, /Jane Doe <jane.doe@corp.com> → agent/);
  const saved = await admin('PUT', '/api/access/ldap', LDAP_CFG);
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.bindPassword, undefined); assert.equal(saved.data.hasBindPassword, true);
  const row = (await pool.query(`SELECT settings->'ldap'->>'bindPassword' AS p FROM tenants`)).rows[0];
  assert.ok(row.p.startsWith('v1.') && !row.p.includes('SvcPass'), 'stored encrypted');
  const st = await client()('GET', '/api/auth/status');
  assert.equal(st.data.activeDirectory, true);
});

test('AD users sign in with username, UPN or email; roles come from (nested) groups', async () => {
  const jane = client();
  const r = await jane('POST', '/api/auth/login', { email: 'jdoe', password: 'Winter2026!' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.user.role, 'agent'); assert.equal(r.data.user.email, 'jane.doe@corp.com');
  const me = (await jane('GET', '/api/auth/me')).data;
  assert.equal(me.user.authSource, 'ldap');
  assert.equal((await client()('POST', '/api/auth/login', { email: 'jdoe@corp.local', password: 'Winter2026!' })).status, 200, 'UPN works');
  assert.equal((await client()('POST', '/api/auth/login', { email: 'JANE.DOE@corp.com', password: 'Winter2026!' })).status, 200, 'email works');
  const ann = await client()('POST', '/api/auth/login', { email: 'aadmin', password: 'Summer2026!' });
  assert.equal(ann.data.user.role, 'admin', 'nested group Helpdesk Leads → ITSM-Admins');
  const bob = await client()('POST', '/api/auth/login', { email: 'bob', password: 'Bob2026pass' });
  assert.equal(bob.data.user.role, 'requester'); assert.equal(bob.data.user.email, 'bob@corp.local');
  // one account per AD user, however they typed their name
  const n = (await pool.query(`SELECT count(*)::int n FROM users WHERE auth_source='ldap' AND name='Jane Doe'`)).rows[0].n;
  assert.equal(n, 1);
});

test('AD rejects wrong, empty, disabled and locked accounts with clear messages', async () => {
  const c = client();
  assert.equal((await c('POST', '/api/auth/login', { email: 'jdoe', password: 'nope' })).status, 401);
  assert.equal((await c('POST', '/api/auth/login', { email: 'jdoe', password: '' })).status, 400, 'empty password never reaches AD');
  assert.equal((await c('POST', '/api/auth/login', { email: 'ghost', password: 'whatever1' })).status, 401);
  const dee = await c('POST', '/api/auth/login', { email: 'dee', password: 'Dee2026pass' });
  assert.equal(dee.status, 403); assert.match(dee.data.error, /disabled in Active Directory/);
  const lou = await c('POST', '/api/auth/login', { email: 'lou', password: 'x' });
  assert.equal(lou.status, 401); assert.match(lou.data.error, /locked out/);
  const inj = await c('POST', '/api/auth/login', { email: '*)(sAMAccountName=*', password: 'Winter2026!' });
  assert.equal(inj.status, 401, 'LDAP filter injection is escaped');
  assert.ok(!ldapLog.some((l) => l.startsWith('bind ') && l.includes('undefined')));
});

test('group changes in AD apply at next sign-in; local break-glass admin still works', async () => {
  const jane = dir.find((e) => e.sAMAccountName === 'jdoe');
  jane.memberOf = [];
  const r = await client()('POST', '/api/auth/login', { email: 'jdoe', password: 'Winter2026!' });
  assert.equal(r.data.user.role, 'requester');
  jane.memberOf = [G('ITSM-Agents')];
  assert.equal((await client()('POST', '/api/auth/login', { email: 'root@corp.com', password: 'LocalAdmin123' })).status, 200);
  // Restricting access to listed groups
  await admin('PUT', '/api/access/ldap', { requesterGroups: ['ITSM-Agents'], defaultRole: 'none' });
  const bob = await client()('POST', '/api/auth/login', { email: 'bob', password: 'Bob2026pass' });
  assert.equal(bob.status, 403); assert.match(bob.data.error, /isn't in a group/);
  await admin('PUT', '/api/access/ldap', { requesterGroups: [], defaultRole: 'requester' });
  // Directory users can't use local password features
  const j = client(); await j('POST', '/api/auth/login', { email: 'jdoe', password: 'Winter2026!' });
  assert.equal((await j('POST', '/api/auth/password', { current: 'x', password: 'Whatever123' })).status, 400);
  const disabled = (await pool.query(`UPDATE users SET active=false WHERE email='bob@corp.local' RETURNING id`)).rows[0];
  assert.ok(disabled);
  const b2 = await client()('POST', '/api/auth/login', { email: 'bob', password: 'Bob2026pass' });
  assert.equal(b2.status, 403, 'an admin can still block a directory user locally');
});

test('Microsoft Entra ID single sign-on: PKCE, signed ID token, group → role', async () => {
  const saved = await admin('PUT', '/api/access/entra', {
    enabled: true, tenantId: TID, clientId: 'app-123', clientSecret: 'entra-secret', authority: `${IDP}/${TID}/v2.0`,
    adminGroups: ['aaaaaaaa-0000-0000-0000-000000000001'], agentGroups: ['ITSM.Agent'],
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.hasClientSecret, true); assert.equal(saved.data.clientSecret, undefined);
  assert.equal((await client()('GET', '/api/auth/status')).data.microsoft, true);

  async function ssoAs(user) {
    nextUser = user;
    const c = client();
    const s = await c('GET', '/api/auth/sso/microsoft/start');
    assert.equal(s.status, 302);
    const authz = new URL(s.location);
    assert.equal(authz.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(authz.searchParams.get('client_id'), 'app-123');
    assert.equal(authz.searchParams.get('redirect_uri'), `${base}/api/auth/sso/microsoft/callback`);
    const back = await fetch(s.location, { redirect: 'manual' });
    const cb = await c('GET', back.headers.get('location'));
    return { c, cb };
  }
  const { c, cb } = await ssoAs({ oid: 'oid-1', email: 'maria@corp.com', name: 'Maria Lopez', roles: ['ITSM.Agent'] });
  assert.equal(cb.status, 302); assert.equal(cb.location, '/#/', cb.location);
  const me = (await c('GET', '/api/auth/me')).data;
  assert.equal(me.user.email, 'maria@corp.com'); assert.equal(me.user.role, 'agent'); assert.equal(me.user.authSource, 'entra');
  const boss = await ssoAs({ oid: 'oid-2', preferred_username: 'boss@corp.com', name: 'The Boss', groups: ['AAAAAAAA-0000-0000-0000-000000000001'] });
  assert.equal((await boss.c('GET', '/api/auth/me')).data.user.role, 'admin');
  const guest = await ssoAs({ oid: 'oid-3', email: 'guest@corp.com', name: 'Guest' });
  assert.equal((await guest.c('GET', '/api/auth/me')).data.user.role, 'requester');
  assert.equal(idpLog.every((q) => q.nonce && q.state), true);

  // Tampering: a callback without the matching state cookie is refused
  nextUser = { oid: 'oid-9', email: 'evil@corp.com', name: 'Evil' };
  const s = await client()('GET', '/api/auth/sso/microsoft/start');
  const back = await fetch(s.location, { redirect: 'manual' });
  const stranger = client();
  const cb2 = await stranger('GET', back.headers.get('location'));
  assert.match(decodeURIComponent(cb2.location), /took too long|could not be verified/);
  assert.equal((await stranger('GET', '/api/auth/me')).status, 401);
  // A token for another Entra tenant is refused
  nextUser = { oid: 'oid-8', email: 'x@other.com', name: 'X', tid: '99999999-9999-9999-9999-999999999999' };
  const other = await ssoAs(nextUser);
  assert.match(decodeURIComponent(other.cb.location), /different organization/);
});

test('invitations: local users get a set-password link; admins see how people sign in', async () => {
  await admin('PUT', '/api/access/ldap', { enabled: false });
  await admin('PUT', '/api/access/entra', { enabled: false });
  const r = await admin('POST', '/api/users', { name: 'New Tech', email: 'newtech@corp.com', role: 'agent' });
  assert.equal(r.status, 201); assert.equal(r.data.invite.method, 'password-link');
  const pr = (await pool.query(`SELECT pr.* FROM password_resets pr JOIN users u ON u.id=pr.user_id WHERE u.email='newtech@corp.com'`)).rows[0];
  assert.equal(pr.purpose, 'invite'); assert.ok(new Date(pr.expires_at) - Date.now() > 6 * 86400000);
  const access = (await admin('GET', '/api/access')).data;
  assert.equal(access.url, base); assert.equal(access.portalUrl, `${base}/#/home`);
  assert.equal(access.entraRedirectUri, `${base}/api/auth/sso/microsoft/callback`);
  assert.equal((await admin('PUT', '/api/access/url', { public_url: 'not a url' })).status, 400);
  const list = (await admin('GET', '/api/users')).data;
  assert.ok(list.some((u) => u.auth_source === 'ldap') && list.some((u) => u.auth_source === 'entra'));
  assert.equal((await admin('POST', `/api/users/${r.data.id}/invite`)).status, 200, 'resend');
});

test('LDAPS: encrypted connection verified against the domain CA certificate', async (t) => {
  let key; let cert;
  try {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(d, 'k'), '-out', path.join(d, 'c'), '-days', '2',
      '-subj', '/CN=dc01.corp.local', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
    key = fs.readFileSync(path.join(d, 'k')); cert = fs.readFileSync(path.join(d, 'c'), 'utf8');
  } catch { t.skip('openssl not available'); return; }
  const tlsServer = tls.createServer({ key, cert }, handleLdap);
  await new Promise((r) => tlsServer.listen(0, '127.0.0.1', r));
  const url = `ldaps://127.0.0.1:${tlsServer.address().port}`;
  try {
    const untrusted = await admin('POST', '/api/access/ldap/test', { ...LDAP_CFG, url, caCert: '', tlsVerify: true });
    assert.equal(untrusted.data.ok, false, 'self-signed DC cert is rejected unless trusted');
    const trusted = await admin('POST', '/api/access/ldap/test', { ...LDAP_CFG, url, caCert: cert, tlsVerify: true, testUser: 'jdoe', testPassword: 'Winter2026!' });
    assert.equal(trusted.data.ok, true, JSON.stringify(trusted.data.steps));
    assert.match(trusted.data.steps[0].detail, /encrypted/);
    await admin('PUT', '/api/access/ldap', { ...LDAP_CFG, url, caCert: cert, tlsVerify: true });
    const r = await client()('POST', '/api/auth/login', { email: 'aadmin', password: 'Summer2026!' });
    assert.equal(r.status, 200); assert.equal(r.data.user.role, 'admin');
  } finally { tlsServer.close(); await admin('PUT', '/api/access/ldap', { enabled: false }); }
});
