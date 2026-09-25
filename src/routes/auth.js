import { tx, one, many, q } from '../db/index.js';
import { HttpError, bad, rateLimit, forbidden } from '../lib/http.js';
import { validate, str, email } from '../lib/validate.js';
import {
  hashPassword, verifyPassword, passwordProblem, signToken, sessionCookie, clearCookie, audit, hashApiKey,
} from '../lib/auth.js';
import crypto from 'node:crypto';
import { sendEmail } from '../lib/notify.js';
import { billingFor } from '../lib/plans.js';
import { provisionTenant } from '../lib/tenant.js';
import { ldapAuthenticate } from '../lib/directory.js';
import { tenantSettings, resolveSsoTenant, upsertDirectoryUser } from '../lib/provision.js';
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

  // Sign in with a local password, or (when the workspace has Active Directory set up) with a
  // Windows username / UPN / email and AD password. Local accounts always work as a break-glass path.
  r.post('/api/auth/login', async (req, res) => {
    loginLimit(req); loginPerEmail(req);
    const b = validate({ email: str({ required: true, max: 200 }), password: str({ required: true, max: 200 }), workspace: str({ max: 60 }) }, req.body);
    const ident = b.email.trim().toLowerCase();
    const users = await many(`SELECT u.*, t.slug, t.name AS tenant_name FROM users u JOIN tenants t ON t.id = u.tenant_id
      WHERE lower(u.email) = $1 AND ($2::text IS NULL OR t.slug = $2)`, [ident, b.workspace || null]);
    if (users.length > 1) throw new HttpError(409, 'This email belongs to several workspaces. Enter your workspace name.', { needWorkspace: true });
    let u = users[0];
    const localOk = u?.password_hash && u.auth_source === 'local' && await verifyPassword(b.password, u.password_hash);
    if (!localOk) {
      // Try Active Directory for this workspace (the user's own, the named one, or the server's only one)
      const t = u ? { id: u.tenant_id } : await resolveSsoTenant(b.workspace, 'ldap');
      const { ldap } = t ? await tenantSettings(t.id) : { ldap: null };
      if (!ldap?.enabled || (u && u.auth_source === 'local' && u.password_hash)) {
        if (!u?.password_hash) await verifyPassword(b.password, null); // equalize timing
        req.user = u ? { id: u.id, tenant_id: u.tenant_id } : null;
        await audit(req, 'auth.login_failed', 'user', u?.id, { email: ident });
        throw new HttpError(401, 'Incorrect email or password');
      }
      try {
        const profile = await ldapAuthenticate(ldap, b.email, b.password);
        u = await upsertDirectoryUser(t.id, profile);
      } catch (e) {
        req.user = { id: u?.id ?? null, tenant_id: t.id };
        await audit(req, 'auth.login_failed', 'user', u?.id, { username: ident, method: 'ldap', reason: e.message });
        throw e;
      }
    }
    if (!u.active) throw new HttpError(401, 'Incorrect email or password');
    await q('UPDATE users SET last_login_at = now() WHERE id=$1', [u.id]);
    req.user = u; await audit(req, 'auth.login', 'user', u.id, { method: localOk ? 'password' : 'ldap' });
    const tenant = await one('SELECT name, slug FROM tenants WHERE id=$1', [u.tenant_id]);
    const token = startSession(res, u);
    return { user: { id: u.id, name: u.name, email: u.email, role: u.role, tenant_id: u.tenant_id }, tenant, token };
  }, { public: true });

  // Self-service password reset (also how email-created requesters set their first password).
  // Always answers the same way so it can't be used to discover which emails exist.
  r.post('/api/auth/forgot', async (req) => {
    forgotLimit(req);
    const b = validate({ email: email({ required: true }), workspace: str({ max: 60 }) }, req.body);
    const users = await many(`SELECT u.id, u.email, u.name, t.slug FROM users u JOIN tenants t ON t.id=u.tenant_id
      WHERE lower(u.email)=$1 AND u.active AND u.auth_source='local' AND ($2::text IS NULL OR t.slug=$2)`, [b.email, b.workspace || null]);
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
      if (!pr) throw bad('This link is invalid or has expired. Ask your administrator to send a new invitation, or use "Forgot password?".');
      await d.query('UPDATE password_resets SET used_at = now() WHERE id=$1', [pr.id]);
      return d.one('UPDATE users SET password_hash=$2, sessions_valid_after=$3 WHERE id=$1 AND active RETURNING id, tenant_id, role, name, email', [pr.user_id, hash, new Date()]);
    });
    if (!u) throw bad('Account is disabled');
    req.user = u; await audit(req, 'auth.password_reset', 'user', u.id);
    startSession(res, u);
    return { ok: true };
  }, { public: true });

  // Lets the sign-in page send a brand-new on-prem server straight to first-time setup
  r.get('/api/auth/status', async (req) => {
    const hasTenant = Boolean(await one('SELECT 1 FROM tenants LIMIT 1'));
    const ws = req.query.workspace || null;
    const [ldapT, entraT] = await Promise.all([resolveSsoTenant(ws, 'ldap'), resolveSsoTenant(ws, 'entra')]);
    const ldapOn = ldapT ? (await tenantSettings(ldapT.id)).ldap.enabled : false;
    const entraOn = entraT ? (await tenantSettings(entraT.id)).entra.enabled : false;
    return { edition: config.edition, needsSetup: !hasTenant, signupOpen: config.allowSignup === true || (config.allowSignup === 'first' && !hasTenant),
      activeDirectory: ldapOn, microsoft: entraOn };
  }, { public: true });

  r.post('/api/auth/logout', async (req, res) => {
    res.setHeader('Set-Cookie', clearCookie());
    return { ok: true };
  }, { public: true });

  r.get('/api/auth/me', async (req) => {
    const t = await one('SELECT id, name, slug, plan, timezone FROM tenants WHERE id=$1', [req.user.tenant_id]);
    const tzRow = await one('SELECT timezone, auth_source FROM users WHERE id=$1', [req.user.id]);
    const u = req.user;
    const pending = await one(`SELECT count(*)::int AS n FROM approvals WHERE approver_id=$1 AND state='pending'`, [u.id]);
    const unread = await one('SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND read_at IS NULL', [u.id]);
    const b = await billingFor(u.tenant_id);
    return { user: { id: u.id, name: u.name, email: u.email, role: u.role, company_id: u.company_id, timezone: tzRow.timezone, authSource: tzRow.auth_source },
      tenant: t, timezone: tzRow.timezone || t.timezone, pendingApprovals: pending.n, unread: unread.n,
      billing: { mode: b.mode, plan: b.plan, status: b.status, features: b.features, readOnly: b.readOnly, trialDaysLeft: b.trialDaysLeft, message: b.message, cancelAtPeriodEnd: b.cancelAtPeriodEnd, periodEnd: b.periodEnd } };
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
    const u = await one('SELECT password_hash, auth_source FROM users WHERE id=$1', [req.user.id]);
    if (u.auth_source !== 'local') throw bad('Your password is managed by your organization\'s directory. Change it in Windows / Microsoft 365.');
    if (!(await verifyPassword(b.current, u.password_hash))) throw bad('Current password is incorrect');
    const pwErr = passwordProblem(b.password); if (pwErr) throw bad(pwErr);
    // Sign out every other session, then issue a fresh one for this browser
    await q('UPDATE users SET password_hash=$2, sessions_valid_after=$3 WHERE id=$1', [req.user.id, await hashPassword(b.password), new Date()]);
    await audit(req, 'auth.password_changed', 'user', req.user.id);
    startSession(res, req.user);
    return { ok: true };
  });
}
