// Notifications: in-app (always), email via Resend, chat via Slack/Teams webhooks. All best-effort.
import { config } from '../config.js';
import { q, many } from '../db/index.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function post(url, body, headers = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(url, { method: 'POST', signal: ctrl.signal, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    if (!r.ok) console.warn(`notify ${new URL(url).host} -> ${r.status}`);
  } catch (e) { console.warn('notify failed:', e.message); } finally { clearTimeout(t); }
}

export async function sendEmail(to, subject, text) {
  if (!to) return;
  if (!config.resendKey) { if (!config.isProd && process.env.NODE_ENV !== 'test') console.log(`[email:dev] to=${to} subject=${subject}`); return; }
  await post('https://api.resend.com/emails', {
    from: config.emailFrom, to: [to], subject,
    html: `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5">${esc(text).replace(/\n/g, '<br>')}</div>`, text,
  }, { authorization: `Bearer ${config.resendKey}` });
}

export async function chat(text) {
  if (config.slackWebhook) await post(config.slackWebhook, { text });
  if (config.teamsWebhook) await post(config.teamsWebhook, { text });
}

const link = (t) => `${config.appUrl}/#/tickets/${t.id}`;

// Notify a set of users in-app + email. `publicFacing` controls whether requesters get the email.
export async function notifyUsers(tenantId, userIds, ticket, kind, message, { email = true } = {}) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return;
  try {
    const users = await many('SELECT id, email, name FROM users WHERE tenant_id=$1 AND id = ANY($2::int[]) AND active', [tenantId, ids]);
    for (const u of users) {
      await q('INSERT INTO notifications (tenant_id, user_id, ticket_id, kind, message) VALUES ($1,$2,$3,$4,$5)', [tenantId, u.id, ticket?.id ?? null, kind, message]);
      if (email) sendEmail(u.email, `[${ticket?.number || 'ITSM'}] ${message}`, `${message}\n\n${ticket ? `${ticket.number}: ${ticket.title}\n${link(ticket)}` : ''}\n\nReply to this email to add a comment.`);
    }
  } catch (e) { console.warn('notifyUsers failed:', e.message); }
}

export async function notifyGroup(tenantId, groupId, ticket, kind, message) {
  if (!groupId) return;
  const rows = await many('SELECT user_id FROM group_members WHERE group_id=$1', [groupId]);
  await notifyUsers(tenantId, rows.map((r) => r.user_id), ticket, kind, message);
}

export function majorIncidentAlert(ticket) {
  chat(`:rotating_light: P${ticket.priority} ${ticket.number}: ${ticket.title}\n${link(ticket)}`);
}
