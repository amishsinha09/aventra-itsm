import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { one, q } from '../db/index.js';
import { HttpError, forbidden } from './http.js';

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1 };

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(pw, stored) {
  if (!stored) { await scrypt(pw, 'timing-pad', 64, SCRYPT); return false; }
  const [alg, N, r, p, salt, key] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(key, 'base64');
  const got = await scrypt(pw, Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(expected, got);
}

export function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password must be at least 10 characters';
  if (pw.length > 200) return 'Password is too long';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Password must contain letters and numbers';
  return null;
}

const b64u = (b) => Buffer.from(b).toString('base64url');

export function signToken(payload, hours = config.sessionHours) {
  const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const body = b64u(JSON.stringify({ ...payload, iat: now, iat_ms: Date.now(), exp: now + hours * 3600 }));
  const sig = crypto.createHmac('sha256', config.jwtSecret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

export function verifyToken(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const expected = crypto.createHmac('sha256', config.jwtSecret).update(`${parts[0]}.${parts[1]}`).digest();
  const got = Buffer.from(parts[2], 'base64url');
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url'));
    if (header.alg !== 'HS256') return null;
    const p = JSON.parse(Buffer.from(parts[1], 'base64url'));
    if (!p.exp || p.exp < Date.now() / 1000) return null;
    return p;
  } catch { return null; }
}

export const hashApiKey = (k) => crypto.createHash('sha256').update(k).digest('hex');

export function newApiKey() {
  const raw = 'avk_' + crypto.randomBytes(24).toString('base64url');
  return { raw, prefix: raw.slice(0, 10), hash: hashApiKey(raw) };
}

export const SESSION_COOKIE = 'itsm_session';

export function sessionCookie(token) {
  const secure = config.cookieSecure ? '; Secure' : '';
  return `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${config.sessionHours * 3600}${secure}`;
}
export const clearCookie = () => `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`;

// Resolve the caller: session cookie / Bearer JWT for people, X-API-Key for integrations.
export async function authenticate(req) {
  const apiKey = req.headers['x-api-key'];
  if (apiKey) {
    const k = await one(`UPDATE api_keys SET last_used_at = now() WHERE key_hash = $1 AND revoked_at IS NULL
                         RETURNING id, tenant_id, name, scopes`, [hashApiKey(apiKey)]);
    if (!k) throw new HttpError(401, 'Invalid API key');
    return { kind: 'apikey', id: null, tenant_id: k.tenant_id, role: 'integration', name: `API: ${k.name}`, scopes: k.scopes, keyId: k.id };
  }
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const token = bearer || req.cookies[SESSION_COOKIE];
  if (!token) throw new HttpError(401, 'Sign in required');
  const p = verifyToken(token);
  if (!p || p.typ) throw new HttpError(401, 'Session expired, please sign in again'); // typ marks non-session tokens (e.g. SSO state)
  const u = await one(`SELECT id, tenant_id, company_id, email, name, role, active, sessions_valid_after FROM users WHERE id = $1 AND tenant_id = $2`, [p.sub, p.tid]);
  if (!u || !u.active) throw new HttpError(401, 'Account disabled');
  if ((p.iat_ms ?? p.iat * 1000) < new Date(u.sessions_valid_after).getTime()) throw new HttpError(401, 'Session expired, please sign in again');
  delete u.sessions_valid_after;
  // Cookie-authenticated mutations must carry a custom header (CSRF defence on top of SameSite=Strict)
  if (!bearer && req.method !== 'GET' && req.headers['x-requested-with'] !== 'itsm') throw forbidden('Missing CSRF header');
  return { kind: 'user', ...u };
}

export const isStaff = (u) => u.role === 'admin' || u.role === 'agent';

export function requireRole(...roles) {
  return (req) => {
    if (!roles.includes(req.user.role)) throw forbidden('You do not have permission to do that');
  };
}
export const staffOnly = requireRole('admin', 'agent');
export const adminOnly = requireRole('admin');
export const integrationOnly = (req) => {
  if (req.user.kind !== 'apikey' || !req.user.scopes.includes('integrations')) throw forbidden('Integration API key required');
};

export async function audit(req, action, entity, entityId, data) {
  try {
    await q(`INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, data, ip) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [req.user?.tenant_id ?? null, req.user?.id ?? null, action, entity, entityId == null ? null : String(entityId), data ? JSON.stringify(data) : null, req.ip]);
  } catch (e) { console.error('audit failed', e.message); }
}
