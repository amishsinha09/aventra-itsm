import { tx, one, many, q } from '../db/index.js';
import { HttpError, bad, rateLimit, forbidden } from '../lib/http.js';
import { validate, str, email } from '../lib/validate.js';
import {
  hashPassword, verifyPassword, passwordProblem, signToken, sessionCookie, clearCookie, audit, hashApiKey,
} from '../lib/auth.js';
import crypto from 'node:crypto';
import { sendEmail } from '../lib/notify.js';
import { provisionTenant } from '../lib/tenant.js';
import { config } from '../config.js';

export const isTimeZone = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };

const loginLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
const loginPerEmail = rateLimit({ windowMs: 15 * 60 * 1000, max: 8, key: (req) => `e:${String(req.body?.email || '').toLowerCase()}` });
const signupLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 10 });
const forgotLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });

function startSession(res, user) {
  const token = signToken({ sub: user.id, tid: user.tenant_id, role: user.role });
  res.setHeader('Set-Cookie', sessionCookie(token));
  return token;
}

export default function (r) {
  r.post('/api/auth/signup', async (req, res) => {
    if (!config.allowSignup) throw forbidden('Self-service signup is disabled');
    if (config.allowSignup === 'first' && (await one('SELECT 1 FROM tenants LIMIT 1'))) throw forbidden('This server is already set up. Ask your administrator for an account.');
    signupLimit(req);
    const b = validate({
      organization: str({ required: true, max: 120, min: 2 }), name: str({ required: true, max: 120 }),
      email: email({ required: true, max: 200 }), password: str({ required: true, max: 200 }),
    }, req.body);
    const pwErr = passwordProblem(b.password); if (pwErr) throw bad(pwErr);
    let slug = b.organization.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'workspace';
    if (await one('SELECT 1 FROM tenants WHERE slug=$1', [slug])) slug = `${slug}-${Math.random().toString(36).slice(2, 7)}`;
    const password_hash = await hashPassword(b.password);
    const { user, tenant } = await tx((db) => provisionTenant(db, { name: b.organization, slug, admin: { email: b.email, name: b.name, password_hash } }));
    req.user = user;
    await audit(req, 'tenant.signup', 'tenant', tenant.id);
    const token = startSession(res, user);
    res.statusCode = 201;
    return { user, tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug }, token };
  }, { public: true });

  r.post('/api/auth/login', async (req, res) => {
    loginLimit(req); loginPerEmail(req);
    const b = validate({ email: email({ required: true }), password: str({ required: true, max: 200 }), workspace: str({ max: 60 }) }, req.body);
    const users = await many(`SELECT u.*, t.slug, t.name AS tenant_name FROM users u JOIN tenants t ON t.id = u.tenant_id
      WHERE lower(u.email) = $1 AND ($2::text IS NULL OR t.slug = $2)`, [b.email, b.workspace || null]);
    if (users.length > 1) throw new HttpError(409, 'This email belongs to several workspaces. Enter your workspace name.', { needWorkspace: true });
    const u = users[0];
    const ok = await verifyPassword(b.password, u?.password_hash);
    if (!u || !ok || !u.active) {
      req.user = u ? { id: u.id, tenant_id: u.tenant_id } : null;
      await audit(req, 'auth.login_failed', 'user', u?.id, { email: b.email });
      throw new HttpError(401, 'Incorrect email or password');
    }
    await q('UPDATE users SET last_login_at = now() WHERE id=$1', [u.id]);
    req.user = u; await audit(req, 'auth.login', 'user', u.id);
    const token = startSession(res, u);
    return { user: { id: u.id, name: u.name, email: u.email, role: u.role, tenant_id: u.tenant_id }, tenant: { name: u.tenant_name, slug: u.slug }, token };
  }, { public: true });

  // Self-service password reset (also how email-created requesters set their first password).
  // Always answers the same way so it can't be used to discover which emails exist.
  r.post('/api/auth/forgot', async (req) => {
    forgotLimit(req);
    const b = validate({ email: email({ required: true }), workspace: str({ max: 60 }) }, req.body);
    const users = await many(`SELECT u.id, u.email, u.name, t.slug FROM users u JOIN tenants t ON t.id=u.tenant_id
      WHERE lower(u.email)=$1 AND u.active AND ($2::text IS NULL OR t.slug=$2)`, [b.email, b.workspace || null]);
    for (const u of users) {
      const raw = crypto.randomBytes(32).toString('base64url');
      await q(`UPDATE password_resets SET used_at = now() WHERE user_id=$1 AND used_at IS NULL`, [u.id]);
      await q(`INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1,$2, now() + interval '1 hour')`, [u.id, hashApiKey(raw)]);
      sendEmail(u.email, 'Reset your Aventra service desk password',
        `Hi ${u.name},\n\nUse this link within 1 hour to set a new password (workspace: ${u.slug}):\n${config.appUrl}/#/reset?token=${raw}\n\nIf you didn't ask for this, you can ignore this email.`);
      req.user = { id: u.id, tenant_id: null }; await audit(req, 'auth.reset_requested', 'user', u.id);
    }
    return { ok: true, message: 'If that email has an account, a reset link is on its way.' };
  }, { public: true });

  r.post('/api/auth/reset', async (req, res) => {
    forgotLimit(req);
    const b = validate({ token: str({ required: true, max: 200 }), password: str({ required: true, max: 200 }) }, req.body);
    const pwErr = passwordProblem(b.password); if (pwErr) throw bad(pwErr);
    const hash = await hashPassword(b.password);
    const u = await tx(async (d) => {
      const pr = await d.one(`SELECT * FROM password_resets WHERE token_hash=$1 AND used_at IS NULL AND expires_at > now() FOR UPDATE`, [hashApiKey(b.token)]);
      if (!pr) throw bad('This reset link is invalid or has expired');
      await d.query('UPDATE password_resets SET used_at = now() WHERE id=$1', [pr.id]);
      return d.one('UPDATE users SET password_hash=$2, sessions_valid_after=$3 WHERE id=$1 AND active RETURNING id, tenant_id, role, name, email', [pr.user_id, hash, new Date()]);
    });
    if (!u) throw bad('Account is disabled');
    req.user = u; await audit(req, 'auth.password_reset', 'user', u.id);
    startSession(res, u);
    return { ok: true };
  }, { public: true });

  // Lets the sign-in page send a brand-new on-prem server straight to first-time setup
  r.get('/api/auth/status', async () => {
    const hasTenant = Boolean(await one('SELECT 1 FROM tenants LIMIT 1'));
    return { edition: config.edition, needsSetup: !hasTenant, signupOpen: config.allowSignup === true || (config.allowSignup === 'first' && !hasTenant) };
  }, { public: true });

  r.post('/api/auth/logout', async (req, res) => {
    res.setHeader('Set-Cookie', clearCookie());
    return { ok: true };
  }, { public: true });

  r.get('/api/auth/me', async (req) => {
    const t = await one('SELECT id, name, slug, plan, timezone FROM tenants WHERE id=$1', [req.user.tenant_id]);
    const tzRow = await one('SELECT timezone FROM users WHERE id=$1', [req.user.id]);
    const u = req.user;
    const pending = await one(`SELECT count(*)::int AS n FROM approvals WHERE approver_id=$1 AND state='pending'`, [u.id]);
    const unread = await one('SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND read_at IS NULL', [u.id]);
    return { user: { id: u.id, name: u.name, email: u.email, role: u.role, company_id: u.company_id, timezone: tzRow.timezone },
      tenant: t, timezone: tzRow.timezone || t.timezone, pendingApprovals: pending.n, unread: unread.n };
  });

  // Personal preferences (currently: time zone; null = follow the workspace)
  r.patch('/api/auth/profile', async (req) => {
    const b = validate({ timezone: str({ max: 64 }), name: str({ max: 120, min: 1 }) }, req.body, { partial: true });
    if (b.timezone && !isTimeZone(b.timezone)) throw bad('Unknown time zone');
    const cols = Object.keys(b); if (!cols.length) throw bad('Nothing to update');
    await q(`UPDATE users SET ${cols.map((k, i) => `${k}=$${i + 2}`).join(',')} WHERE id=$1`, [req.user.id, ...cols.map((k) => b[k] || null)]);
    return { ok: true };
  });

  r.post('/api/auth/password', async (req, res) => {
    const b = validate({ current: str({ required: true, max: 200 }), password: str({ required: true, max: 200 }) }, req.body);
    const u = await one('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
    if (!(await verifyPassword(b.current, u.password_hash))) throw bad('Current password is incorrect');
    const pwErr = passwordProblem(b.password); if (pwErr) throw bad(pwErr);
    // Sign out every other session, then issue a fresh one for this browser
    await q('UPDATE users SET password_hash=$2, sessions_valid_after=$3 WHERE id=$1', [req.user.id, await hashPassword(b.password), new Date()]);
    await audit(req, 'auth.password_changed', 'user', req.user.id);
    startSession(res, req.user);
    return { ok: true };
  });
}
