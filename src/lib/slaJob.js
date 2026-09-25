// Background SLA monitor: flags breaches and sends 80% warnings. Safe with multiple instances
// (advisory lock ensures only one instance runs each sweep).
import { pool } from '../db/index.js';
import { notifyUsers, notifyGroup, chat } from './notify.js';

export async function slaSweep() {
  const c = await pool.connect();
  try {
    const lock = await c.query('SELECT pg_try_advisory_lock(727275) AS ok', []);
    if (!lock.rows[0].ok) return { skipped: true };
    try {
      // Breaches: resolution overdue, or first response overdue. Paused tickets are excluded.
      const breached = (await c.query(`UPDATE tickets SET sla_breached = true, updated_at = now()
        WHERE resolved_at IS NULL AND sla_paused_at IS NULL AND NOT sla_breached
          AND (resolve_due < now() OR (responded_at IS NULL AND response_due < now()))
        RETURNING id, tenant_id, number, title, priority, assignee_id, group_id,
          CASE WHEN resolve_due < now() THEN 'resolution' ELSE 'response' END AS kind`, [])).rows;
      for (const t of breached) {
        await c.query(`INSERT INTO ticket_events (tenant_id, ticket_id, actor_label, kind, field, new_value) VALUES ($1,$2,'SLA monitor','sla','breached',$3)`, [t.tenant_id, t.id, t.kind]);
        const msg = `SLA breached (${t.kind}) on ${t.number}`;
        if (t.assignee_id) notifyUsers(t.tenant_id, [t.assignee_id], t, 'sla', msg);
        else notifyGroup(t.tenant_id, t.group_id, t, 'sla', msg);
        if (t.priority <= 2) chat(`:warning: ${msg}: ${t.title}`);
      }
      // Warnings at 80% of the resolution window
      const warned = (await c.query(`UPDATE tickets SET sla_warned = true
        WHERE resolved_at IS NULL AND sla_paused_at IS NULL AND NOT sla_warned AND NOT sla_breached AND resolve_due IS NOT NULL
          AND now() > created_at + (resolve_due - created_at) * 0.8
        RETURNING id, tenant_id, number, title, assignee_id, group_id`, [])).rows;
      for (const t of warned) {
        const msg = `${t.number} will breach its SLA soon`;
        if (t.assignee_id) notifyUsers(t.tenant_id, [t.assignee_id], t, 'sla_warning', msg);
        else notifyGroup(t.tenant_id, t.group_id, t, 'sla_warning', msg);
      }
      // Auto-close incidents resolved more than 5 days ago (ITIL practice) and fulfilled requests
      await c.query(`UPDATE tickets SET status='closed', closed_at=now(), updated_at=now()
        WHERE ((type='incident' AND status='resolved') OR (type='request' AND status='fulfilled')) AND resolved_at < now() - interval '5 days'`, []);
      return { breached: breached.length, warned: warned.length };
    } finally {
      await c.query('SELECT pg_advisory_unlock(727275)', []);
    }
  } finally { c.release(); }
}

export function startSlaJob(intervalSec) {
  const run = () => slaSweep().catch((e) => console.error('SLA sweep failed:', e.message));
  const h = setInterval(run, intervalSec * 1000);
  h.unref();
  setTimeout(run, 5000).unref();
  return h;
}
