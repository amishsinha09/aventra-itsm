// Integration endpoints (API-key authenticated):
//  - Aventra self-healing agent events  -> incidents opened / escalated / auto-resolved
//  - Aventra inventory feed             -> CMDB discovery
//  - Inbound email                      -> new tickets or comments on existing ones
import { tx, one, many } from '../db/index.js';
import { bad } from '../lib/http.js';
import { validate, str, oneOf, arr, obj } from '../lib/validate.js';
import { integrationOnly, audit } from '../lib/auth.js';
import { requireFeature } from '../lib/plans.js';
import { createTicket, updateTicket, addComment, getTicket, later } from '../lib/tickets.js';
import { upsertDiscoveredCI } from './cmdb.js';
import { notifyGroup } from '../lib/notify.js';

const SEVERITY = { critical: [1, 1], high: [2, 1], medium: [2, 2], low: [3, 3] }; // -> [impact, urgency]

const eventSchema = {
  event: oneOf(['alert.opened', 'remediation.started', 'remediation.succeeded', 'remediation.failed', 'alert.cleared'], { required: true }),
  alert_id: str({ required: true, max: 120 }), hostname: str({ max: 200 }), company: str({ max: 120 }),
  severity: oneOf(Object.keys(SEVERITY), { default: 'medium' }), title: str({ max: 200 }), description: str({ max: 20000 }),
  playbook: str({ max: 200 }), message: str({ max: 5000 }), ip_address: str({ max: 64 }), os: str({ max: 120 }), details: obj(),
};

export default function (r) {
  r.post('/api/integrations/aventra/events', integrationOnly, requireFeature('aventra'), async (req) => {
    const e = validate(eventSchema, req.body);
    const actor = { ...req.user, name: 'Aventra Agent' };
    const result = await tx(async (d) => {
      const tenantId = actor.tenant_id;
      const ci = e.hostname ? await upsertDiscoveredCI(d, tenantId, { hostname: e.hostname, company: e.company, ip_address: e.ip_address, os: e.os }) : null;
      let t = await d.one(`SELECT * FROM tickets WHERE tenant_id=$1 AND external_ref=$2 AND type='incident' ORDER BY id DESC LIMIT 1 FOR UPDATE`, [tenantId, `aventra:${e.alert_id}`]);
      const reopenable = t && !t.resolved_at;

      const open = async () => {
        const [impact, urgency] = SEVERITY[e.severity];
        const created = await createTicket(d, actor, {
          type: 'incident', title: e.title || `Aventra alert on ${e.hostname || 'device'}`, description: e.description || e.message || '',
          impact, urgency, ci_id: ci?.id ?? null, company_id: ci?.company_id ?? null, group_id: ci?.support_group_id ?? undefined,
          source: 'aventra', external_ref: `aventra:${e.alert_id}`, details: { aventra: { severity: e.severity, playbook: e.playbook, ...(e.details || {}) } },
        });
        return d.one('SELECT * FROM tickets WHERE id=$1', [created.id]);
      };

      let action;
      switch (e.event) {
        case 'alert.opened':
          if (reopenable) { await addComment(d, actor, t, `Alert fired again${e.message ? `: ${e.message}` : ''}`, true); action = 'deduplicated'; break; }
          t = await open(); action = 'created';
          if (ci && e.severity === 'critical') await d.query(`UPDATE cis SET status='down', updated_at=now() WHERE id=$1`, [ci.id]);
          else if (ci) await d.query(`UPDATE cis SET status='degraded', updated_at=now() WHERE id=$1 AND status='operational'`, [ci.id]);
          break;
        case 'remediation.started':
          if (!reopenable) t = await open();
          await addComment(d, actor, t, `Self-healing started${e.playbook ? ` (playbook: ${e.playbook})` : ''}.`, true);
          if (t.status === 'new') t = await updateTicket(d, actor, t, { status: 'in_progress' });
          action = 'in_progress'; break;
        case 'remediation.succeeded':
          if (!reopenable) t = await open();
          await addComment(d, actor, t, `Self-healing succeeded${e.playbook ? ` (playbook: ${e.playbook})` : ''}. ${e.message || ''}`.trim(), true);
          t = await d.one('SELECT * FROM tickets WHERE id=$1', [t.id]);
          await updateTicket(d, actor, t, { status: 'resolved', resolution_code: 'auto_remediated',
            resolution_notes: `Automatically remediated by Aventra${e.playbook ? ` using ${e.playbook}` : ''}. ${e.message || ''}`.trim() });
          await d.query('UPDATE tickets SET auto_remediated = true WHERE id=$1', [t.id]);
          if (ci) await d.query(`UPDATE cis SET status='operational', updated_at=now() WHERE id=$1 AND status IN ('degraded','down')`, [ci.id]);
          action = 'auto_resolved'; break;
        case 'remediation.failed': {
          if (!reopenable) t = await open();
          await addComment(d, actor, t, `Self-healing FAILED${e.playbook ? ` (playbook: ${e.playbook})` : ''}. ${e.message || ''} Escalating to a technician.`.trim(), true);
          t = await d.one('SELECT * FROM tickets WHERE id=$1', [t.id]);
          const patch = { urgency: 1 };
          if (t.status === 'new') patch.status = 'in_progress';
          if (!t.group_id && ci?.support_group_id) patch.group_id = ci.support_group_id;
          t = await updateTicket(d, actor, t, patch);
          later(d, () => notifyGroup(tenantId, t.group_id, t, 'escalation', `${t.number}: automatic fix failed, needs a technician`));
          action = 'escalated'; break;
        }
        case 'alert.cleared':
          if (reopenable) {
            await updateTicket(d, actor, t, { status: 'resolved', resolution_code: 'no_fault_found', resolution_notes: `Alert cleared on its own. ${e.message || ''}`.trim() });
            if (ci) await d.query(`UPDATE cis SET status='operational', updated_at=now() WHERE id=$1 AND status IN ('degraded','down')`, [ci.id]);
            action = 'resolved';
          } else action = 'ignored';
          break;
        default: throw bad('Unknown event');
      }
      return { action, ticket: t ? await getTicket(d, tenantId, t.id) : null };
    });
    await audit(req, `aventra.${e.event}`, 'ticket', result.ticket?.id, { alert_id: e.alert_id, action: result.action });
    return { action: result.action, ticket: result.ticket && { id: result.ticket.id, number: result.ticket.number, status: result.ticket.status, priority: result.ticket.priority } };
  });

  r.post('/api/integrations/aventra/inventory', integrationOnly, requireFeature('aventra'), async (req) => {
    const b = validate({ devices: arr(obj({ maxBytes: 5000 }), { required: true, max: 1000 }) }, req.body);
    const out = await tx(async (d) => {
      const res = [];
      for (const dev of b.devices) {
        const v = validate({ hostname: str({ required: true, max: 200 }), company: str({ max: 120 }), ip_address: str({ max: 64 }), os: str({ max: 120 }),
          serial_number: str({ max: 120 }), ci_class: str({ max: 40 }), attributes: obj() }, dev);
        const ci = await upsertDiscoveredCI(d, req.user.tenant_id, v);
        res.push({ id: ci.id, name: ci.name });
      }
      return res;
    });
    await audit(req, 'aventra.inventory', 'ci', null, { count: out.length });
    return { upserted: out.length, cis: out };
  });

  // Inbound email relay (Resend / Postmark / SendGrid inbound parse → forward as JSON with the API key).
  r.post('/api/integrations/email/inbound', integrationOnly, async (req) => {
    const b = validate({ from: str({ required: true, max: 300 }), subject: str({ max: 300 }), text: str({ max: 50000 }) }, req.body);
    const fromEmail = (b.from.match(/<([^>]+)>/)?.[1] || b.from).trim().toLowerCase();
    const fromName = b.from.replace(/<[^>]+>/, '').replace(/"/g, '').trim() || fromEmail.split('@')[0];
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromEmail)) throw bad('Invalid sender');
    const body = stripQuoted(b.text || '');
    const tenantId = req.user.tenant_id;

    const result = await tx(async (d) => {
      let user = await d.one('SELECT * FROM users WHERE tenant_id=$1 AND lower(email)=$2', [tenantId, fromEmail]);
      if (!user) {
        // Only auto-register senders from a known customer domain (prevents spam tickets)
        const company = await d.one('SELECT * FROM companies WHERE tenant_id=$1 AND active AND lower(domain)=$2', [tenantId, fromEmail.split('@')[1]]);
        if (!company) return { action: 'rejected_unknown_sender' };
        user = await d.one(`INSERT INTO users (tenant_id, company_id, email, name, role) VALUES ($1,$2,$3,$4,'requester') RETURNING *`, [tenantId, company.id, fromEmail, fromName.slice(0, 120)]);
      }
      if (!user.active) return { action: 'rejected_inactive_user' };
      const actor = { kind: 'user', ...user };
      const ref = (b.subject || '').match(/\b(INC|REQ|PRB|CHG)\d{7}\b/);
      if (ref) {
        const t = await d.one('SELECT * FROM tickets WHERE tenant_id=$1 AND number=$2 FOR UPDATE', [tenantId, ref[0]]);
        const staff = user.role !== 'requester';
        if (t && (staff || t.requester_id === user.id)) {
          await addComment(d, actor, t, body || '(empty email)', false);
          return { action: 'commented', ticket: { id: t.id, number: t.number } };
        }
      }
      const t = await createTicket(d, { ...actor, role: user.role }, {
        type: 'incident', title: (b.subject || 'Email request').slice(0, 200), description: body,
      });
      await d.query(`UPDATE tickets SET source='email' WHERE id=$1`, [t.id]);
      return { action: 'created', ticket: { id: t.id, number: t.number } };
    });
    return result;
  });
}

function stripQuoted(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (const l of lines) {
    if (/^On .+wrote:$/.test(l.trim()) || /^-{2,}\s*Original Message/i.test(l) || /^From: /.test(l)) break;
    if (l.startsWith('>')) continue;
    out.push(l);
  }
  return out.join('\n').trim();
}
