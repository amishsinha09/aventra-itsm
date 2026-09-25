import { one, many, q } from '../db/index.js';
import { isStaff, staffOnly } from '../lib/auth.js';

async function tzFor(user) {
  const r = await one('SELECT coalesce(u.timezone, t.timezone) AS tz FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1', [user.id]);
  return r?.tz || 'America/Chicago';
}

export default function (r) {
  r.get('/api/dashboard', async (req) => {
    const t = req.user.tenant_id;
    if (!isStaff(req.user)) {
      const mine = await many(`SELECT id, number, type, title, status, priority, updated_at FROM tickets
        WHERE tenant_id=$1 AND requester_id=$2 ORDER BY (resolved_at IS NULL) DESC, updated_at DESC LIMIT 20`, [t, req.user.id]);
      return { mine };
    }
    const tz = await tzFor(req.user);
    const [counts, byPriority, sla, mttr, auto, trend, byCategory, upcoming, aging, groups, csat] = await Promise.all([
      one(`SELECT
          count(*) FILTER (WHERE type='incident' AND resolved_at IS NULL)::int AS open_incidents,
          count(*) FILTER (WHERE type='request' AND resolved_at IS NULL)::int AS open_requests,
          count(*) FILTER (WHERE type='problem' AND resolved_at IS NULL)::int AS open_problems,
          count(*) FILTER (WHERE type='change' AND resolved_at IS NULL)::int AS open_changes,
          count(*) FILTER (WHERE resolved_at IS NULL AND assignee_id = $2)::int AS assigned_to_me,
          count(*) FILTER (WHERE resolved_at IS NULL AND assignee_id IS NULL AND type IN ('incident','request'))::int AS unassigned,
          count(*) FILTER (WHERE resolved_at IS NULL AND sla_breached)::int AS breached_open,
          count(*) FILTER (WHERE resolved_at IS NULL AND type='incident' AND priority=1)::int AS p1_open
        FROM tickets WHERE tenant_id=$1`, [t, req.user.id]),
      many(`SELECT priority, count(*)::int AS n FROM tickets WHERE tenant_id=$1 AND resolved_at IS NULL AND type IN ('incident','request') GROUP BY priority ORDER BY priority`, [t]),
      one(`SELECT count(*)::int AS total, count(*) FILTER (WHERE NOT sla_breached)::int AS met FROM tickets
        WHERE tenant_id=$1 AND type IN ('incident','request') AND resolved_at > now() - interval '30 days' AND resolve_due IS NOT NULL`, [t]),
      one(`SELECT round(avg(extract(epoch FROM resolved_at - created_at))/3600.0, 1)::float AS hours,
          round(avg(extract(epoch FROM resolved_at - created_at)) FILTER (WHERE auto_remediated)/60.0, 1)::float AS auto_minutes
        FROM tickets WHERE tenant_id=$1 AND type='incident' AND resolved_at > now() - interval '30 days' AND status <> 'canceled'`, [t]),
      one(`SELECT count(*) FILTER (WHERE auto_remediated)::int AS auto, count(*)::int AS total FROM tickets
        WHERE tenant_id=$1 AND type='incident' AND created_at > now() - interval '30 days'`, [t]),
      // Days are bucketed in the workspace/user time zone (e.g. America/Chicago)
      many(`WITH days AS (SELECT generate_series((now() AT TIME ZONE $2)::date - 13, (now() AT TIME ZONE $2)::date, interval '1 day')::date AS d)
        SELECT to_char(days.d, 'YYYY-MM-DD') AS day,
          (SELECT count(*)::int FROM tickets WHERE tenant_id=$1 AND (created_at AT TIME ZONE $2)::date = days.d) AS created,
          (SELECT count(*)::int FROM tickets WHERE tenant_id=$1 AND (resolved_at AT TIME ZONE $2)::date = days.d) AS resolved
        FROM days ORDER BY days.d`, [t, tz]),
      many(`SELECT coalesce(category,'Uncategorized') AS category, count(*)::int AS n FROM tickets WHERE tenant_id=$1 AND resolved_at IS NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 8`, [t]),
      many(`SELECT id, number, title, status, details->>'planned_start' AS planned_start, details->>'risk' AS risk FROM tickets
        WHERE tenant_id=$1 AND type='change' AND status IN ('scheduled','pending_approval','implementing')
          AND (details->>'planned_start')::timestamptz < now() + interval '14 days' ORDER BY details->>'planned_start' LIMIT 8`, [t]),
      many(`SELECT CASE WHEN age < interval '1 day' THEN '< 1 day' WHEN age < interval '3 days' THEN '1–3 days'
            WHEN age < interval '7 days' THEN '3–7 days' ELSE '> 7 days' END AS bucket, count(*)::int AS n
        FROM (SELECT now() - created_at AS age FROM tickets WHERE tenant_id=$1 AND resolved_at IS NULL AND type IN ('incident','request')) x GROUP BY 1`, [t]),
      many(`SELECT g.id, g.name, count(tk.id)::int AS open FROM groups g LEFT JOIN tickets tk ON tk.group_id = g.id AND tk.resolved_at IS NULL
        WHERE g.tenant_id=$1 GROUP BY g.id ORDER BY open DESC, g.name`, [t]),
      one(`SELECT round(avg(csat_score)::numeric, 2)::float AS avg, count(*)::int AS responses,
          count(*) FILTER (WHERE csat_score >= 4)::int AS satisfied
        FROM tickets WHERE tenant_id=$1 AND csat_at > now() - interval '30 days'`, [t]),
    ]);
    const order = ['< 1 day', '1–3 days', '3–7 days', '> 7 days'];
    return {
      counts, byPriority, byCategory, upcoming, groups, trend,
      aging: order.map((b) => ({ bucket: b, n: aging.find((a) => a.bucket === b)?.n || 0 })),
      sla: { ...sla, pct: sla.total ? Math.round((sla.met / sla.total) * 1000) / 10 : null },
      mttr_hours: mttr.hours, auto_mttr_minutes: mttr.auto_minutes,
      auto: { ...auto, pct: auto.total ? Math.round((auto.auto / auto.total) * 1000) / 10 : null },
      csat: { ...csat, pct: csat.responses ? Math.round((csat.satisfied / csat.responses) * 1000) / 10 : null },
      timezone: tz,
    };
  });

  // MSP / management reporting: per-customer and per-agent scorecards over a period.
  r.get('/api/reports', staffOnly, async (req) => {
    const t = req.user.tenant_id;
    const days = [7, 30, 90, 365].includes(+req.query.days) ? +req.query.days : 30;
    const tz = await tzFor(req.user);
    const since = `now() - interval '${days} days'`;
    const scorecard = (groupCol, joinSql, nameSql, extraWhere = '') => many(`SELECT ${nameSql} AS name, ${groupCol} AS id,
        count(*) FILTER (WHERE tk.created_at > ${since})::int AS created,
        count(*) FILTER (WHERE tk.resolved_at > ${since} AND tk.status <> 'canceled')::int AS resolved,
        count(*) FILTER (WHERE tk.resolved_at IS NULL)::int AS open,
        count(*) FILTER (WHERE tk.resolved_at > ${since} AND tk.resolve_due IS NOT NULL)::int AS sla_total,
        count(*) FILTER (WHERE tk.resolved_at > ${since} AND tk.resolve_due IS NOT NULL AND NOT tk.sla_breached)::int AS sla_met,
        count(*) FILTER (WHERE tk.created_at > ${since} AND tk.auto_remediated)::int AS auto,
        count(*) FILTER (WHERE tk.created_at > ${since} AND tk.type = 'incident')::int AS incidents,
        round(avg(extract(epoch FROM tk.resolved_at - tk.created_at) / 3600.0) FILTER (WHERE tk.resolved_at > ${since} AND tk.type='incident' AND tk.status <> 'canceled')::numeric, 1)::float AS mttr_hours,
        round(avg(tk.csat_score) FILTER (WHERE tk.csat_at > ${since})::numeric, 2)::float AS csat_avg,
        count(tk.csat_score) FILTER (WHERE tk.csat_at > ${since})::int AS csat_n
      FROM tickets tk ${joinSql} WHERE tk.tenant_id = $1 AND tk.type IN ('incident','request') ${extraWhere}
      GROUP BY ${groupCol}, ${nameSql} ORDER BY created DESC NULLS LAST`, [t]);
    const [companies, agents, comments, csatTrend] = await Promise.all([
      scorecard('co.id', 'LEFT JOIN companies co ON co.id = tk.company_id', `coalesce(co.name, 'No company')`),
      scorecard('u.id', 'JOIN users u ON u.id = tk.assignee_id', 'u.name'),
      many(`SELECT tk.id, tk.number, tk.title, tk.csat_score, tk.csat_comment, tk.csat_at, r.name AS requester_name, a.name AS assignee_name, co.name AS company_name
        FROM tickets tk LEFT JOIN users r ON r.id=tk.requester_id LEFT JOIN users a ON a.id=tk.assignee_id LEFT JOIN companies co ON co.id=tk.company_id
        WHERE tk.tenant_id=$1 AND tk.csat_at > ${since} ORDER BY tk.csat_at DESC LIMIT 25`, [t]),
      many(`SELECT csat_score AS score, count(*)::int AS n FROM tickets WHERE tenant_id=$1 AND csat_at > ${since} GROUP BY 1 ORDER BY 1`, [t]),
    ]);
    const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
    const shape = (r) => ({ ...r, sla_pct: pct(r.sla_met, r.sla_total), auto_pct: pct(r.auto, r.incidents) });
    return { days, timezone: tz, companies: companies.map(shape), agents: agents.map(shape), comments,
      csatDistribution: [1, 2, 3, 4, 5].map((s) => ({ score: s, n: csatTrend.find((x) => x.score === s)?.n || 0 })) };
  });

  r.get('/api/notifications', async (req) => many(`SELECT n.*, t.number FROM notifications n LEFT JOIN tickets t ON t.id = n.ticket_id
    WHERE n.user_id=$1 ORDER BY n.created_at DESC LIMIT 30`, [req.user.id]));

  r.post('/api/notifications/read', async (req) => {
    await q('UPDATE notifications SET read_at = now() WHERE user_id=$1 AND read_at IS NULL', [req.user.id]);
    return { ok: true };
  });

  // Search across tickets, KB and CIs for the global search box
  r.get('/api/search', async (req) => {
    const term = String(req.query.q || '').trim().slice(0, 200);
    if (!term) return { tickets: [], kb: [], cis: [] };
    const staff = isStaff(req.user);
    const t = req.user.tenant_id;
    const tickets = await many(`SELECT id, number, type, title, status FROM tickets WHERE tenant_id=$1 ${staff ? '' : 'AND requester_id=$3'}
      AND (number = upper($2) OR search @@ websearch_to_tsquery('english', $2)) ORDER BY created_at DESC LIMIT 8`, staff ? [t, term] : [t, term, req.user.id]);
    const kb = await many(`SELECT id, number, title FROM kb_articles WHERE tenant_id=$1 AND status='published' ${staff ? '' : `AND audience='public'`}
      AND search @@ websearch_to_tsquery('english', $2) LIMIT 5`, [t, term]);
    const cis = staff ? await many(`SELECT id, name, ci_class FROM cis WHERE tenant_id=$1 AND name ILIKE $2 LIMIT 5`, [t, `%${term.replace(/[%_\\]/g, '\\$&')}%`]) : [];
    return { tickets, kb, cis };
  });
}
