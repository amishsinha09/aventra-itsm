// Microsoft Entra ID (Azure AD / Microsoft 365) single sign-on via OpenID Connect:
// authorization code flow + PKCE, ID token verified against Entra's published signing keys (JWKS).
// Settings live in tenants.settings.entra (client secret encrypted).
import crypto from 'node:crypto';
import { HttpError } from './http.js';
import { decryptSecret } from './secrets.js';

export const DEFAULT_ENTRA = {
  enabled: false, tenantId: '', clientId: '', clientSecret: null, authority: '',
  adminGroups: [], agentGroups: [], requesterGroups: [], defaultRole: 'requester',
};

export const authorityFor = (cfg) => (cfg.authority || `https://login.microsoftonline.com/${cfg.tenantId}/v2.0`).replace(/\/$/, '');

const cache = new Map();
async function getJson(url, ttlMs = 3600_000, force = false) {
  const hit = cache.get(url);
  if (!force && hit && hit.at > Date.now() - ttlMs) return hit.value;
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`${url} → ${r.status}`);
    const value = await r.json();
    cache.set(url, { at: Date.now(), value });
    return value;
  } finally { clearTimeout(t); }
}
export const discovery = (cfg) => getJson(`${authorityFor(cfg)}/.well-known/openid-configuration`);

const b64u = (b) => Buffer.from(b).toString('base64url');
export function pkcePair() {
  const verifier = b64u(crypto.randomBytes(32));
  return { verifier, challenge: b64u(crypto.createHash('sha256').update(verifier).digest()) };
}

export async function authorizeUrl(cfg, { redirectUri, state, nonce, challenge, loginHint }) {
  const d = await discovery(cfg);
  const u = new URL(d.authorization_endpoint);
  u.search = new URLSearchParams({
    client_id: cfg.clientId, response_type: 'code', redirect_uri: redirectUri, response_mode: 'query',
    scope: 'openid profile email', state, nonce, code_challenge: challenge, code_challenge_method: 'S256',
    ...(loginHint ? { login_hint: loginHint } : {}),
  }).toString();
  return u.toString();
}

export async function exchangeCode(cfg, { code, verifier, redirectUri }) {
  const d = await discovery(cfg);
  const r = await fetch(d.token_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: cfg.clientId,
      client_secret: decryptSecret(cfg.clientSecret), code_verifier: verifier, scope: 'openid profile email',
    }).toString(),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.id_token) throw new HttpError(401, `Microsoft sign-in failed: ${j.error_description?.split('\r\n')[0] || j.error || r.status}`);
  return j;
}

// Verify an RS256 ID token: signature (JWKS), issuer, audience, expiry, nonce and tenant.
export async function verifyIdToken(cfg, idToken, nonce) {
  const [h, p, s] = String(idToken).split('.');
  if (!s) throw new HttpError(401, 'Malformed ID token');
  const header = JSON.parse(Buffer.from(h, 'base64url'));
  if (header.alg !== 'RS256') throw new HttpError(401, 'Unexpected token algorithm');
  const d = await discovery(cfg);
  let keys = await getJson(d.jwks_uri);
  let jwk = keys.keys?.find((k) => k.kid === header.kid);
  if (!jwk) { keys = await getJson(d.jwks_uri, 0, true); jwk = keys.keys?.find((k) => k.kid === header.kid); } // key rollover
  if (!jwk) throw new HttpError(401, 'Unknown signing key');
  const pub = crypto.createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' });
  if (!crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), pub, Buffer.from(s, 'base64url'))) throw new HttpError(401, 'Invalid token signature');
  const c = JSON.parse(Buffer.from(p, 'base64url'));
  const now = Date.now() / 1000;
  // Wrong organization first (clearest message), then the exact issuer
  if (cfg.tenantId && c.tid !== cfg.tenantId) throw new HttpError(403, 'This Microsoft account belongs to a different organization.');
  const expectedIss = (d.issuer || '').replace('{tenantid}', c.tid || '');
  if (c.iss !== expectedIss) throw new HttpError(401, 'Token issuer mismatch');
  if (c.aud !== cfg.clientId) throw new HttpError(401, 'Token audience mismatch');
  if (!c.exp || c.exp < now - 60) throw new HttpError(401, 'Token expired');
  if (c.nbf && c.nbf > now + 60) throw new HttpError(401, 'Token not yet valid');
  if (c.nonce !== nonce) throw new HttpError(401, 'Token nonce mismatch');
  return c;
}

// Map Entra group object IDs and app-role values to a service-desk role
export function profileFromClaims(cfg, c) {
  const have = new Set([...(c.groups || []), ...(c.roles || [])].map((x) => String(x).toLowerCase()));
  const hit = (list) => (list || []).some((g) => have.has(String(g).trim().toLowerCase()));
  let role = hit(cfg.adminGroups) ? 'admin' : hit(cfg.agentGroups) ? 'agent' : hit(cfg.requesterGroups) ? 'requester' : null;
  if (!role && !cfg.requesterGroups?.length && cfg.defaultRole !== 'none') role = 'requester';
  if (!role) throw new HttpError(403, 'Your account isn\'t in a group that has access to the service desk. Ask your IT administrator.');
  const email = (c.email || c.preferred_username || c.upn || '').toLowerCase();
  if (!email) throw new HttpError(403, 'Your Microsoft account has no email address.');
  return { source: 'entra', externalId: c.oid || c.sub, email, name: c.name || email, role, groups: [...(c.groups || []), ...(c.roles || [])].slice(0, 50) };
}
