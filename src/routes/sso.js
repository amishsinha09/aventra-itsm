// Sign-in integrations: Active Directory (LDAP) settings + test, Microsoft Entra SSO,
// the "share with your team" info and invitations.
import crypto from 'node:crypto';
import { one, q } from '../db/index.js';
import { bad, notFound, HttpError } from '../lib/http.js';
import { validate, str, bool, oneOf, arr, int } from '../lib/validate.js';
import { adminOnly, audit, signToken, verifyToken, sessionCookie } from '../lib/auth.js';
import { encryptSecret } from '../lib/secrets.js';
import { testDirectory } from '../lib/directory.js';
import { authorizeUrl, exchangeCode, verifyIdToken, profileFromClaims, pkcePair, discovery } from '../lib/oidc.js';
import { tenantSettings, saveSettings, publicUrl, resolveSsoTenant, upsertDirectoryUser, sendInvite } from '../lib/provision.js';
import { config } from '../config.js';

const groupList = arr(str({ max: 400 }), { max: 50 });
const OIDC_COOKIE = 'itsm_oidc';
const cookieFlags = () => `HttpOnly; Path=/api/auth/sso; SameSite=Lax; Max-Age=600${config.cookieSecure ? '; Secure' : ''}`;

function redactLdap(c) { const { bindPassword, ...rest } = c; return { ...rest, hasBindPassword: Boolean(bindPassword) }; }
function redactEntra(c) { const { clientSecret, ...rest } = c; return { ...rest, hasClientSecret: Boolean(clientSecret) }; }

export default function (r) {
  // ---- What to give users: sign-in link, portal link, desktop app
  r.get('/api/access', adminOnly, async (req) => {
    const { settings, ldap, entra, tenant } = await tenantSettings(req.user.tenant_id);
    const url = publicUrl(settings);
    return {
      workspace: tenant.slug, url, portalUrl: `${url}/#/home`, desktopDownload: 'https://aventratech.org/itsm.html#download',
      publicUrlCustom: Boolean(settings.public_url), defaultUrl: config.appUrl,
      ldap: redactLdap(ldap), entra: redactEntra(entra),
      entraRedirectUri: `${url}/api/auth/sso/microsoft/callback`, edition: config.edition,
    };
  });

  r.put('/api/access/url', adminOnly, async (req) => {
    const b = validate({ public_url: str({ max: 200 }) }, req.body);
    let v = (b.public_url || '').trim().replace(/\/$/, '');
    if (v && !/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(v)) throw bad('Enter an address like http://servicedesk.company.local or https://itsm.company.com');
    await saveSettings(req.user.tenant_id, { public_url: v || null });
    await audit(req, 'access.url_changed', 'tenant', req.user.tenant_id, { public_url: v });
    return { url: publicUrl({ public_url: v }) };
  });

  // ---- Active Directory (LDAP)
  const ldapSchema = {
    enabled: bool(), url: str({ max: 300 }), startTls: bool(), tlsVerify: bool(), caCert: str({ max: 20000 }),
    baseDN: str({ max: 400 }), bindDN: str({ max: 400 }), bindPassword: str({ max: 500 }), userFilter: str({ max: 1000 }),
    adminGroups: groupList, agentGroups: groupList, requesterGroups: groupList,
    defaultRole: oneOf(['requester', 'none']), nestedGroups: bool(),
  };
  async function mergedLdap(tenantId, body) {
    const { ldap } = await tenantSettings(tenantId);
    const b = validate(ldapSchema, body, { partial: true });
    const next = { ...ldap, ...b };
    if ('bindPassword' in b) next.bindPassword = b.bindPassword ? encryptSecret(b.bindPassword) : ldap.bindPassword; // blank = keep
    if (next.userFilter && !next.userFilter.includes('{username}')) throw bad('The user filter must contain {username}');
    if (next.enabled) {
      if (!/^ldaps?:\/\//i.test(next.url || '')) throw bad('Server address must start with ldaps:// (recommended) or ldap://');
      if (!next.baseDN || !next.bindDN || !next.bindPassword) throw bad('Base DN, service account and its password are required');
    }
    return next;
  }
  r.put('/api/access/ldap', adminOnly, async (req) => {
    const next = await mergedLdap(req.user.tenant_id, req.body);
    await saveSettings(req.user.tenant_id, { ldap: next });
    await audit(req, 'access.ldap_updated', 'tenant', req.user.tenant_id, { enabled: next.enabled, url: next.url });
    return redactLdap(next);
  });
  // Test with the settings on screen (not yet saved); optional test user
  r.post('/api/access/ldap/test', adminOnly, async (req) => {
    const { testUser, testPassword, ...cfgBody } = req.body || {};
    const cfg = await mergedLdap(req.user.tenant_id, { ...cfgBody, enabled: true });
    const steps = await testDirectory(cfg, { username: testUser, password: testPassword });
    return { ok: steps.every((s) => s.ok), steps };
  });

  // ---- Microsoft Entra ID
  const entraSchema = {
    enabled: bool(), tenantId: str({ max: 100 }), clientId: str({ max: 100 }), clientSecret: str({ max: 500 }), authority: str({ max: 300 }),
    adminGroups: groupList, agentGroups: groupList, requesterGroups: groupList, defaultRole: oneOf(['requester', 'none']),
  };
  r.put('/api/access/entra', adminOnly, async (req) => {
    const { entra } = await tenantSettings(req.user.tenant_id);
    const b = validate(entraSchema, req.body, { partial: true });
    const next = { ...entra, ...b };
    if ('clientSecret' in b) next.clientSecret = b.clientSecret ? encryptSecret(b.clientSecret) : entra.clientSecret;
    if (next.enabled) {
      if (!/^[0-9a-f-]{36}$/i.test(next.tenantId || '') && !next.authority) throw bad('Directory (tenant) ID should look like 00000000-0000-0000-0000-000000000000');
      if (!next.clientId || !next.clientSecret) throw bad('Application (client) ID and client secret are required');
      try { await discovery(next); } catch (e) { throw bad(`Couldn't reach Microsoft for this tenant: ${e.message}`); }
    }
    await saveSettings(req.user.tenant_id, { entra: next });
    await audit(req, 'access.entra_updated', 'tenant', req.user.tenant_id, { enabled: next.enabled, tenantId: next.tenantId });
    return redactEntra(next);
  });

  // ---- Microsoft sign-in flow
  r.get('/api/auth/sso/microsoft/start', async (req, res) => {
    const t = await resolveSsoTenant(req.query.workspace, 'entra');
    const fail = (msg) => { res.statusCode = 302; res.setHeader('Location', `/#/login?error=${encodeURIComponent(msg)}`); return { __raw: '' }; };
    if (!t) return fail('Microsoft sign-in isn\'t set up for this workspace.');
    const { entra, settings } = await tenantSettings(t.id);
    if (!entra.enabled) return fail('Microsoft sign-in isn\'t set up for this workspace.');
    const state = crypto.randomBytes(16).toString('base64url');
    const nonce = crypto.randomBytes(16).toString('base64url');
    const { verifier, challenge } = pkcePair();
    const redirectUri = `${publicUrl(settings)}/api/auth/sso/microsoft/callback`;
    const url = await authorizeUrl(entra, { redirectUri, state, nonce, challenge, loginHint: req.query.hint });
    res.setHeader('Set-Cookie', `${OIDC_COOKIE}=${signToken({ typ: 'oidc', tid: t.id, state, nonce, verifier }, 0.2)}; ${cookieFlags()}`);
    res.statusCode = 302; res.setHeader('Location', url);
    return { __raw: '' };
  }, { public: true });

  r.get('/api/auth/sso/microsoft/callback', async (req, res) => {
    const done = (loc, cookies = []) => {
      res.setHeader('Set-Cookie', [`${OIDC_COOKIE}=; ${cookieFlags().replace('Max-Age=600', 'Max-Age=0')}`, ...cookies]);
      res.statusCode = 302; res.setHeader('Location', loc); return { __raw: '' };
    };
    const fail = (msg) => done(`/#/login?error=${encodeURIComponent(msg)}`);
    const st = verifyToken(req.cookies[OIDC_COOKIE] || '');
    if (!st || st.typ !== 'oidc') return fail('Your sign-in took too long. Please try again.');
    if (req.query.error) return fail(req.query.error_description?.split('\r\n')[0] || 'Microsoft sign-in was canceled.');
    if (!req.query.code || req.query.state !== st.state) return fail('Sign-in could not be verified. Please try again.');
    try {
      const { entra, settings } = await tenantSettings(st.tid);
      if (!entra.enabled) return fail('Microsoft sign-in is turned off.');
      const tokens = await exchangeCode(entra, { code: req.query.code, verifier: st.verifier, redirectUri: `${publicUrl(settings)}/api/auth/sso/microsoft/callback` });
      const claims = await verifyIdToken(entra, tokens.id_token, st.nonce);
      const user = await upsertDirectoryUser(st.tid, profileFromClaims(entra, claims));
      req.user = user; await audit(req, 'auth.login', 'user', user.id, { method: 'entra' });
      const token = signToken({ sub: user.id, tid: user.tenant_id, role: user.role });
      return done('/#/', [sessionCookie(token)]);
    } catch (e) {
      if (!(e instanceof HttpError)) console.error('Entra sign-in error:', e);
      req.user = { tenant_id: st.tid }; await audit(req, 'auth.login_failed', 'tenant', st.tid, { method: 'entra', reason: e.message });
      return fail(e instanceof HttpError ? e.message : 'Microsoft sign-in failed. Please try again.');
    }
  }, { public: true });

  // ---- Invitations
  r.post('/api/users/:id/invite', adminOnly, async (req) => {
    const u = await one('SELECT * FROM users WHERE tenant_id=$1 AND id=$2 AND active', [req.user.tenant_id, +req.params.id || 0]);
    if (!u) throw notFound('User not found');
    const out = await sendInvite(req.user.tenant_id, u, req.user.name);
    await audit(req, 'user.invited', 'user', u.id);
    return out;
  });
}
