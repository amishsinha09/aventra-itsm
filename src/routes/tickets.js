import { tx, db, many, one } from '../db/index.js';
import { bad, notFound } from '../lib/http.js';
import { validate, str, int, oneOf, obj, bool } from '../lib/validate.js';
import { isStaff, staffOnly, audit } from '../lib/auth.js';
import {
  TICKET_SELECT, getTicket, assertCanView, createTicket, updateTicket, addComment, decideApproval, changeConflicts, logEvent, later,
} from '../lib/tickets.js';
import { notifyUsers, notifyGroup } from '../lib/notify.js';
import { TICKET_TYPES, ALL_STATUSES, RESOLUTION_CODES, CATEGORIES, LIFECYCLE, PREFIX, nextNumber } from '../lib/itsm.js';
import { suggestions, draftReply, kbFromTicket, aiEnabled } from '../lib/ai.js';

const createSchema = {
  type: oneOf(TICKET_TYPES, { required: true }),
  title: str({ max: 200 }), description: str({ max: 20000 }),
  impact: int({ min: 1, max: 3 }), urgency: int({ min: 1, max: 3 }),
  category: str({ max: 60 }), company_id: int(), requester_id: int(), assignee_id: int(), group_id: int(),
  ci_id: int(), problem_id: int(), catalog_item_id: int(), details: obj(),
};
const updateSchema = {
  title: str({ max: 200, min: 1 }), description: str({ max: 20000 }), status: oneOf(ALL_STATUSES),
  impact: int({ min: 1, max: 3 }), urgency: int({ min: 1, max: 3 }), category: str({ max: 60 }),
  company_id: int(), requester_id: int(), assignee_id: int(), group_id: int(), ci_id: int(), problem_id: int(),
  details: obj(), resolution_code: oneOf(RESOLUTION_CODES), resolution_notes: str({ max: 20000 }),
};

const SORTS = { newest: 't.created_at DESC', oldest: 't.created_at ASC', priority: 't.priority ASC, t.created_at ASC',
  updated: 't.updated_at DESC', due: 't.resolve_due ASC NULLS LAST' };

function buildFilter(req) {
  const f = req.query; const u = req.user;
  const where = ['t.tenant_id = $1']; const params = [u.tenant_id];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (!isStaff(u)) add('t.requester_id = ?', u.id);
  if (f.type && TICKET_TYPES.includes(f.type)) add('t.type = ?', f.type);
  if (f.status) add('t.status = ANY(?::text[])', f.status.split(',').filter((s) => ALL_STATUSES.includes(s)));
  if (f.open === 'true') where.push('t.resolved_at IS NULL');
  if (f.open === 'false') where.push('t.resolved_at IS NOT NULL');
  if (f.priority && /^[1-4]$/.test(f.priority)) add('t.priority = ?', +f.priority);
  if (f.assignee === 'me') add('t.assignee_id = ?', u.id);
  else if (f.assignee === 'none') where.push('t.assignee_id IS NULL');
  else if (/^\d+$/.test(f.assignee || '')) add('t.assignee_id = ?', +f.assignee);
  if (f.group === 'mine') add('t.group_id IN (SELECT group_id FROM group_members WHERE user_id = ?)', u.id);
  else if (/^\d+$/.test(f.group || '')) add('t.group_id = ?', +f.group);
  if (/^\d+$/.test(f.company || '')) add('t.company_id = ?', +f.company);
  if (/^\d+$/.test(f.ci || '')) add('t.ci_id = ?', +f.ci);
  if (/^\d+$/.test(f.problem || '')) add('t.problem_id = ?', +f.problem);
  if (f.breached === 'true') where.push('t.sla_breached');
  if (f.source) add('t.source = ?', f.source);
  if (f.category) add('t.category = ?', f.category);
  if (f.q && f.q.trim()) {
    const term = f.q.trim().slice(0, 200);
    if (/^[A-Z]{2,3}\d{7}$/i.test(term)) add('t.number = ?', term.toUpperCase());
    else add(`t.search @@ websearch_to_tsquery('english', ?)`, term);
  }
  return { where: where.join(' AND '), params };
}

export default function (r) {
  r.get('/api/meta', async () => ({
    types: TICKET_TYPES, statuses: Object.fromEntries(Object.entries(LIFECYCLE).map(([k, v]) => [k, Object.keys(v.transitions)])),
    transitions: Object.fromEntries(Object.entries(LIFECYCLE).map(([k, v]) => [k, v.transitions])),
    resolutionCodes: RESOLUTION_CODES, categories: CATEGORIES, ai: aiEnabled(),
  }));

  r.get('/api/tickets', async (req) => {
    const { where, params } = buildFilter(req);
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const sort = SORTS[req.query.sort] || SORTS.newest;
    const total = await one(`SELECT count(*)::int AS n FROM tickets t WHERE ${where}`, params);
    const rows = await many(`${TICKET_SELECT} WHERE ${where} ORDER BY ${sort} LIMIT ${limit} OFFSET ${(page - 1) * limit}`, params);
    return { total: total.n, page, limit, rows: rows.map(slim) };
  });

  r.get('/api/tickets/export.csv', staffOnly, async (req, res) => {
    const { where, params } = buildFilter(req);
    const rows = await many(`${TICKET_SELECT} WHERE ${where} ORDER BY t.created_at DESC LIMIT 10000`, params);
    const cols = ['number', 'type', 'title', 'status', 'priority', 'category', 'company_name', 'requester_name', 'assignee_name', 'group_name', 'ci_name', 'source', 'sla_breached', 'auto_remediated', 'created_at', 'resolved_at', 'resolution_code'];
    const cell = (v) => {
      let s = v instanceof Date ? v.toISOString() : v == null ? '' : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula injection guard
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="tickets.csv"');
    await audit(req, 'tickets.export', 'ticket', null, { count: rows.length });
    return { __raw: [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n') };
  });

  r.post('/api/tickets', async (req, res) => {
    const b = validate(createSchema, req.body);
    const t = await tx((db) => createTicket(db, req.user, b));
    await audit(req, 'ticket.create', 'ticket', t.id, { number: t.number });
    res.statusCode = 201;
    return t;
  });

  r.get('/api/tickets/:id', async (req) => {
    const t = await getTicket(db, req.user.tenant_id, +req.params.id || 0);
    assertCanView(req.user, t);
    const staff = isStaff(req.user);
    const comments = await many(`SELECT c.*, u.name AS author_name, u.role AS author_role FROM ticket_comments c
      LEFT JOIN users u ON u.id = c.author_id WHERE c.ticket_id = $1 ${staff ? '' : 'AND NOT c.internal'} ORDER BY c.created_at`, [t.id]);
    const events = staff ? await many(`SELECT e.*, u.name AS actor_name FROM ticket_events e LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.ticket_id = $1 ORDER BY e.created_at, e.id`, [t.id]) : [];
    const approvals = await many(`SELECT a.*, u.name AS approver_name FROM approvals a JOIN users u ON u.id = a.approver_id
      WHERE a.ticket_id = $1 AND a.state <> 'canceled' ORDER BY a.created_at`, [t.id]);
    const linked = t.type === 'problem' ? await many(`SELECT id, number, title, status, priority FROM tickets WHERE problem_id = $1 ORDER BY created_at DESC`, [t.id]) : [];
    const conflicts = t.type === 'change' ? await changeConflicts(db, t) : [];
    // Requesters get public KB only; similar tickets belong to other people
    const sugg = staff ? await suggestions(db, t) : { kb: (await suggestions(db, t, { audience: 'public' })).kb, similar: [] };
    return { ticket: staff ? { ...t, search: undefined } : slimForRequester(t), comments, events, approvals, linked, conflicts, suggestions: sugg,
      transitions: LIFECYCLE[t.type].transitions[t.status] || [] };
  });

  r.patch('/api/tickets/:id', async (req) => {
    const b = validate(updateSchema, req.body, { partial: true });
    const t = await tx(async (db) => {
      const cur = await db.one('SELECT * FROM tickets WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [req.user.tenant_id, +req.params.id || 0]);
      assertCanView(req.user, cur);
      return updateTicket(db, req.user, cur, b);
    });
    await audit(req, 'ticket.update', 'ticket', t.id, b);
    return t;
  });

  r.post('/api/tickets/:id/comments', async (req, res) => {
    const b = validate({ body: str({ required: true, max: 20000 }), internal: bool() }, req.body);
    const c = await tx(async (db) => {
      const t = await db.one('SELECT * FROM tickets WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [req.user.tenant_id, +req.params.id || 0]);
      assertCanView(req.user, t);
      return addComment(db, req.user, t, b.body, b.internal);
    });
    res.statusCode = 201;
    return c;
  });

  // AI assist: draft reply + likely fix from KB and similar resolved tickets
  r.post('/api/tickets/:id/ai/draft', staffOnly, async (req) => {
    const t = await getTicket(db, req.user.tenant_id, +req.params.id || 0);
    if (!t) throw notFound();
    const comments = await many(`SELECT c.*, u.name AS author_name FROM ticket_comments c LEFT JOIN users u ON u.id=c.author_id WHERE ticket_id=$1 ORDER BY created_at`, [t.id]);
    const s = await suggestions(db, t);
    return { ...(await draftReply(t, s, comments)), suggestions: s };
  });

  // Knowledge-centred service: turn a resolved ticket into a draft KB article
  r.post('/api/tickets/:id/kb', staffOnly, async (req, res) => {
    const t = await getTicket(db, req.user.tenant_id, +req.params.id || 0);
    if (!t) throw notFound();
    if (!t.resolved_at) throw bad('Resolve the ticket before creating an article from it');
    const comments = await many('SELECT body FROM ticket_comments WHERE ticket_id=$1 ORDER BY created_at', [t.id]);
    const draft = await kbFromTicket(t, comments);
    const a = await tx(async (d) => {
      const number = await nextNumber(d, req.user.tenant_id, PREFIX.kb);
      return d.one(`INSERT INTO kb_articles (tenant_id, number, title, body, category, status, audience, author_id, source_ticket_id)
        VALUES ($1,$2,$3,$4,$5,'draft','internal',$6,$7) RETURNING *`, [req.user.tenant_id, number, draft.title, draft.body, t.category, req.user.id, t.id]);
    });
    res.statusCode = 201;
    return a;
  });

  // Customer satisfaction survey: the requester rates a resolved incident/request once.
  r.post('/api/tickets/:id/csat', async (req) => {
    const b = validate({ score: int({ required: true, min: 1, max: 5 }), comment: str({ max: 2000 }) }, req.body);
    const t = await tx(async (d) => {
      const cur = await d.one('SELECT * FROM tickets WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [req.user.tenant_id, +req.params.id || 0]);
      if (!cur || cur.requester_id !== req.user.id) throw notFound('Ticket not found');
      if (!['incident', 'request'].includes(cur.type)) throw bad('Only incidents and requests can be rated');
      if (!cur.resolved_at || ['canceled', 'rejected'].includes(cur.status)) throw bad('You can rate a ticket once it has been resolved');
      if (cur.csat_score) throw bad('You have already rated this ticket');
      await d.query('UPDATE tickets SET csat_score=$2, csat_comment=$3, csat_at=now() WHERE id=$1', [cur.id, b.score, b.comment || null]);
      await logEvent(d, req.user, cur, 'csat', 'score', null, `${b.score}/5${b.comment ? ` — ${b.comment}` : ''}`);
      if (b.score <= 2) {
        const msg = `${cur.number} received a low satisfaction score (${b.score}/5)`;
        if (cur.assignee_id) later(d, () => notifyUsers(cur.tenant_id, [cur.assignee_id], cur, 'csat', msg));
        else later(d, () => notifyGroup(cur.tenant_id, cur.group_id, cur, 'csat', msg));
      }
      return cur;
    });
    await audit(req, 'ticket.csat', 'ticket', t.id, { score: b.score });
    return { ok: true, score: b.score };
  });

  r.get('/api/approvals', async (req) => many(`SELECT a.*, t.number, t.title, t.type, t.priority, t.details, r.name AS requester_name
    FROM approvals a JOIN tickets t ON t.id = a.ticket_id LEFT JOIN users r ON r.id = t.requester_id
    WHERE a.tenant_id = $1 AND a.approver_id = $2 AND a.state = $3 ORDER BY a.created_at`,
  [req.user.tenant_id, req.user.id, ['pending', 'approved', 'rejected'].includes(req.query.state) ? req.query.state : 'pending']));

  r.post('/api/approvals/:id', async (req) => {
    const b = validate({ decision: oneOf(['approved', 'rejected'], { required: true }), comment: str({ max: 2000 }) }, req.body);
    const out = await tx((d) => decideApproval(d, req.user, +req.params.id || 0, b.decision, b.comment));
    await audit(req, `approval.${b.decision}`, 'approval', req.params.id);
    return out;
  });
}

function slim(t) {
  const { search, ai, ...rest } = t;
  return rest;
}
function slimForRequester(t) {
  const { search, ai, details, ...rest } = t;
  return { ...rest, details: t.type === 'request' ? { variables: details?.variables } : {} };
}
