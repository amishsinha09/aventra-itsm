// Shared helpers for sign-in integrations: tenant settings, the public URL users should open,
// just-in-time accounts for directory users, and invitation emails.
import crypto from 'node:crypto';
import { one, many, q, tx } from '../db/index.js';
import { config } from '../config.js';
import { HttpError } from './http.js';
import { hashApiKey } from './auth.js';
import { sendEmail, notifyUsers } from './notify.js';
import { billingFor } from './plans.js';
import { DEFAULT_LDAP } from './directory.js';
import { DEFAULT_ENTRA } from './oidc.js';

export async function tenantSettings(tenantId) {
  const t = await one('SELECT id, name, slug, settings FROM tenants WHERE id=$1', [tenantId]);
  const s = t?.settings || {};
  return { tenant: t, settings: s, ldap: { ...DEFAULT_LDAP, ...(s.ldap || {}) }, entra: { ...DEFAULT_ENTRA, ...(s.entra || {}) } };
}

export async function saveSettings(tenantId, patch) {
  await q(`UPDATE tenants SET settings = settings || $2::jsonb WHERE id=$1`, [tenantId, JSON.stringify(patch)]);
}

// The address people should open (a friendly DNS name if the admin set one)
export const publicUrl = (settings) => String(settings?.public_url || config.appUrl).replace(/\/$/, '');

// Pick the workspace for a sign-in that didn't name one: on-prem servers have exactly one.
export async function resolveSsoTenant(slug, kind) {
  if (slug) return one('SELECT id FROM tenants WHERE slug=$1', [slug]);
  const rows = await many(`SELECT id FROM tenants WHERE (settings->$1->>'enabled')::boolean IS TRUE LIMIT 2`, [kind]);
  return rows.length === 1 ? rows[0] : null;
}

// Create or update the local account for someone who signed in through AD / Entra.
export async function upsertDirectoryUser(tenantId, profile) {
  return tx(async (d) => {
    let u = await d.one('SELECT * FROM users WHERE tenant_id=$1 AND auth_source=$2 AND external_id=$3 FOR UPDATE', [tenantId, profile.source, profile.externalId]);
    // First directory sign-in for someone an admin already added by email: link the accounts
    u ||= await d.one(`SELECT * FROM users WHERE tenant_id=$1 AND lower(email)=$2 AND (external_id IS NULL OR auth_source='local') FOR UPDATE`, [tenantId, profile.email]);
    if (u && !u.active) throw new HttpError(403, 'Your service desk account has been disabled. Contact your administrator.');

    // Technician roles need a free seat; otherwise sign them in as a requester and tell the admins
    let role = profile.role;
    let seatNote = null;
    if (role !== 'requester' && !(u && u.role !== 'requester')) {
      const b = await billingFor(tenantId);
      if (b.seats) {
        const used = await d.one(`SELECT count(*)::int AS n FROM users WHERE tenant_id=$1 AND active AND role IN ('admin','agent') AND ($2::int IS NULL OR id <> $2)`, [tenantId, u?.id ?? null]);
        if (used.n >= b.seats) { seatNote = `${profile.name} is in a technician group but all ${b.seats} seats are in use, so they signed in as a requester. Add seats in Settings → Billing.`; role = 'requester'; }
      }
    }
    if (u) {
      u = await d.one(`UPDATE users SET name=$2, email=$3, role=$4, auth_source=$5, external_id=$6, directory_groups=$7, last_login_at=now()
        WHERE id=$1 RETURNING *`, [u.id, profile.name.slice(0, 120), profile.email, role, profile.source, profile.externalId, profile.groups]);
    } else {
      u = await d.one(`INSERT INTO users (tenant_id, email, name, role, auth_source, external_id, directory_groups, last_login_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7, now()) RETURNING *`, [tenantId, profile.email, profile.name.slice(0, 120), role, profile.source, profile.externalId, profile.groups]);
    }
    if (seatNote) {
      const admins = await d.many(`SELECT id FROM users WHERE tenant_id=$1 AND role='admin' AND active`, [tenantId]);
      setImmediate(() => notifyUsers(tenantId, admins.map((a) => a.id), null, 'seats', seatNote, { email: false }));
    }
    return u;
  });
}

// Invitation: a set-password link (local accounts) or "sign in with your company account" (directory).
export async function sendInvite(tenantId, user, invitedBy) {
  const { tenant, settings, ldap, entra } = await tenantSettings(tenantId);
  const url = publicUrl(settings);
  const directory = ldap.enabled || entra.enabled;
  let body = `Hi ${user.name},\n\n${invitedBy} has invited you to the ${tenant.name} service desk.\n\n`;
  if (directory && !user.password_hash) {
    body += `Sign in here with your usual work account${entra.enabled ? ' ("Sign in with Microsoft")' : ' (your Windows username and password)'}:\n${url}\n`;
  } else {
    const raw = crypto.randomBytes(32).toString('base64url');
    await q(`UPDATE password_resets SET used_at = now() WHERE user_id=$1 AND used_at IS NULL`, [user.id]);
    await q(`INSERT INTO password_resets (user_id, token_hash, expires_at, purpose) VALUES ($1,$2, now() + interval '7 days', 'invite')`, [user.id, hashApiKey(raw)]);
    body += `Choose your password to get started (link valid for 7 days):\n${url}/#/reset?token=${raw}&invite=1\n\nAfter that, sign in any time at:\n${url}\n`;
  }
  body += user.role === 'requester' ? '\nYou can raise and track IT requests there.' : '\nYou can work tickets there, or install the desktop app for notifications.';
  await q('UPDATE users SET invited_at = now() WHERE id=$1', [user.id]);
  sendEmail(user.email, `You're invited to the ${tenant.name} service desk`, body);
  return { url, method: directory && !user.password_hash ? 'directory' : 'password-link' };
}
