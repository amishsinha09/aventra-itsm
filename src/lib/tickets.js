// Ticket service: create/update/comment with lifecycle rules, SLA clock, approvals, history and notifications.
import { bad, forbidden, notFound } from './http.js';
import {
  LIFECYCLE, SYSTEM_ONLY, PREFIX, canTransition, isDone, isPaused, priorityFrom, slaTargets, nextNumber, assessChangeRisk,
} from './itsm.js';
import { heuristicTriage, triage, aiEnabled } from './ai.js';
import { notifyUsers, notifyGroup, majorIncidentAlert } from './notify.js';
import { db as rootDb } from '../db/index.js';
import { isStaff } from './auth.js';
import { assertFeature, billingFor } from './plans.js';

export const TICKET_SELECT = `
  SELECT t.*, r.name AS requester_name, r.email AS requester_email, a.name AS assignee_name, g.name AS group_name,
         c.name AS company_name, ci.name AS ci_name, p.number AS problem_number, cat.name AS catalog_item_name
  FROM tickets t
  LEFT JOIN users r ON r.id = t.requester_id
  LEFT JOIN users a ON a.id = t.assignee_id
  LEFT JOIN groups g ON g.id = t.group_id
  LEFT JOIN companies c ON c.id = t.company_id
  LEFT JOIN cis ci ON ci.id = t.ci_id
  LEFT JOIN tickets p ON p.id = t.problem_id
  LEFT JOIN catalog_items cat ON cat.id = t.catalog_item_id`;

// Run side effects after commit when inside a transaction
export const later = (db, fn) => (db.after ? db.after.push(fn) : Promise.resolve().then(fn).catch(() => {}));

const actorLabel = (actor) => (actor.kind === 'user' ? null : actor.name || 'System');

export async function logEvent(db, actor, ticket, kind, field = null, oldV = null, newV = null) {
  const s = (v) => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v));
  await db.query(`INSERT INTO ticket_events (tenant_id, ticket_id, actor_id, actor_label, kind, field, old_value, new_value)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [ticket.tenant_id, ticket.id, actor.kind === 'user' ? actor.id : null, actorLabel(actor), kind, field, s(oldV), s(newV)]);
}

export async function getTicket(db, tenantId, id) {
  return db.one(`${TICKET_SELECT} WHERE t.tenant_id = $1 AND t.id = $2`, [tenantId, id]);
}

export function assertCanView(actor, ticket) {
  if (!ticket) throw notFound('Ticket not found');
  if (isStaff(actor) || actor.kind === 'apikey') return;
  if (ticket.requester_id !== actor.id) throw notFound('Ticket not found');
}

// Verify that referenced ids belong to the caller's tenant (prevents cross-tenant references).
async function assertOwned(db, tenantId, table, id, label) {
  if (id === null || id === undefined) return null;
  const row = await db.one(`SELECT * FROM ${table} WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  if (!row) throw bad(`${label} not found`);
  return row;
}

async function autoGroup(db, tenantId, category) {
  if (!category) return null;
  const g = await db.one('SELECT id FROM groups WHERE tenant_id=$1 AND $2 = ANY(categories) ORDER BY id LIMIT 1', [tenantId, category]);
  return g?.id ?? null;
}

export async function createTicket(db, actor, input) {
  const tenantId = actor.tenant_id;
  const staff = isStaff(actor) || actor.kind === 'apikey';
  const type = input.type;
  if (!LIFECYCLE[type]) throw bad('Invalid ticket type');
  if (!staff && !['incident', 'request'].includes(type)) throw forbidden('Requesters can only raise incidents and requests');
  if (type === 'problem') await assertFeature(tenantId, 'problems');
  if (type === 'change') await assertFeature(tenantId, 'changes');

  const data = { ...input };
  if (!staff) {
    // Requesters cannot route, assign or classify their own tickets
    for (const k of ['assignee_id', 'group_id', 'problem_id', 'company_id', 'requester_id', 'source', 'external_ref', 'category']) delete data[k];
    data.requester_id = actor.id;
    data.company_id = actor.company_id;
    data.source = 'portal';
  }
  data.requester_id ??= actor.kind === 'user' ? actor.id : null;
  data.source ??= actor.kind === 'apikey' ? 'api' : 'agent';

  const requester = await assertOwned(db, tenantId, 'users', data.requester_id, 'Requester');
  if (requester && data.company_id === undefined) data.company_id = requester.company_id;
  await assertOwned(db, tenantId, 'companies', data.company_id, 'Company');
  const assignee = await assertOwned(db, tenantId, 'users', data.assignee_id, 'Assignee');
  if (assignee && assignee.role === 'requester') throw bad('Assignee must be an agent');
  await assertOwned(db, tenantId, 'groups', data.group_id, 'Group');
  const ci = await assertOwned(db, tenantId, 'cis', data.ci_id, 'Configuration item');
  if (data.problem_id) {
    const p = await assertOwned(db, tenantId, 'tickets', data.problem_id, 'Problem');
    if (p.type !== 'problem') throw bad('problem_id must reference a problem');
  }

  let catalogItem = null;
  if (type === 'request' && data.catalog_item_id) {
    catalogItem = await assertOwned(db, tenantId, 'catalog_items', data.catalog_item_id, 'Catalog item');
    if (!catalogItem.active) throw bad('That catalog item is no longer available');
    const vars = data.details?.variables || {};
    for (const f of catalogItem.fields || []) {
      if (f.required && (vars[f.name] === undefined || vars[f.name] === '')) throw bad(`${f.label || f.name} is required`);
    }
    data.title ||= catalogItem.name;
    data.category ||= catalogItem.category;
    data.group_id ??= catalogItem.fulfillment_group_id;
  }
  if (!data.title) throw bad('Title is required');

  // Triage: fill in anything the caller didn't decide
  const tri = heuristicTriage(data.title, data.description);
  data.category ||= tri.category;
  const impact = data.impact ?? (staff ? 3 : tri.impact);
  const urgency = data.urgency ?? tri.urgency;
  const priority = priorityFrom(impact, urgency);
  data.group_id ??= await autoGroup(db, tenantId, data.category);

  const details = { ...(data.details || {}) };
  if (type === 'change') {
    details.change_type ||= 'normal';
    Object.assign(details, assessChangeRisk(details, ci?.criticality ?? 3));
  }

  const now = new Date();
  const sla = ['incident', 'request'].includes(type) ? await slaTargets(db, tenantId, type, priority, now) : {};
  const number = await nextNumber(db, tenantId, PREFIX[type]);

  const t = await db.one(`INSERT INTO tickets (tenant_id, number, type, title, description, status, impact, urgency, priority, category,
      company_id, requester_id, assignee_id, group_id, ci_id, problem_id, catalog_item_id, details, source, external_ref, ai,
      response_due, resolve_due, responded_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING *`,
  [tenantId, number, type, data.title, data.description || '', LIFECYCLE[type].initial, impact, urgency, priority, data.category,
    data.company_id ?? null, data.requester_id ?? null, data.assignee_id ?? null, data.group_id ?? null, data.ci_id ?? null,
    data.problem_id ?? null, catalogItem?.id ?? null, JSON.stringify(details), data.source, data.external_ref ?? null,
    JSON.stringify({ triage: tri }), sla.response_due ?? null, sla.resolve_due ?? null, data.assignee_id ? now : null]);

  await logEvent(db, actor, t, 'created', null, null, t.number);

  // Catalog items needing approval go straight to approval
  if (catalogItem?.approval_required) {
    await startApproval(db, actor, t, catalogItem.approver_group_id);
  }

  const full = await getTicket(db, tenantId, t.id);
  // Side effects after the data is written
  const msg = `New ${type} ${full.number} (P${full.priority})`;
  if (full.assignee_id) later(db, () => notifyUsers(tenantId, [full.assignee_id], full, 'assigned', `${full.number} assigned to you`));
  else if (full.group_id) later(db, () => notifyGroup(tenantId, full.group_id, full, 'new', msg));
  if (full.priority === 1 && type === 'incident') later(db, () => majorIncidentAlert(full));
  // Claude enrichment is a Pro feature (and costs money per call)
  if (aiEnabled() && (await billingFor(tenantId)).features.includes('ai')) later(db, () => enrichWithAI(tenantId, full.id, staff));
  return full;
}

async function enrichWithAI(tenantId, ticketId, staffCreated) {
  const t = await rootDb.one('SELECT * FROM tickets WHERE tenant_id=$1 AND id=$2', [tenantId, ticketId]);
  if (!t) return;
  const r = await triage(t.title, t.description);
  const ai = { ...t.ai, triage: r };
  // Only override classification the system guessed (not what a person chose)
  if (!staffCreated && r.engine === 'claude') {
    const priority = priorityFrom(r.impact, r.urgency);
    await rootDb.query('UPDATE tickets SET ai=$3, category=$4, impact=$5, urgency=$6, priority=$7 WHERE tenant_id=$1 AND id=$2',
      [tenantId, ticketId, JSON.stringify(ai), r.category, r.impact, r.urgency, priority]);
  } else {
    await rootDb.query('UPDATE tickets SET ai=$3 WHERE tenant_id=$1 AND id=$2', [tenantId, ticketId, JSON.stringify(ai)]);
  }
}

const STAFF_FIELDS = ['title', 'description', 'status', 'impact', 'urgency', 'category', 'assignee_id', 'group_id', 'ci_id',
  'problem_id', 'company_id', 'requester_id', 'details', 'resolution_code', 'resolution_notes'];

export async function updateTicket(db, actor, ticket, patch, { system = false } = {}) {
  const tenantId = ticket.tenant_id;
  const staff = isStaff(actor) || actor.kind === 'apikey' || system;
  const type = ticket.type;
  const changes = {};

  if (!staff) {
    // Requesters: cancel their open ticket, or reopen a resolved incident. Nothing else.
    const keys = Object.keys(patch);
    if (keys.some((k) => k !== 'status')) throw forbidden('You can only cancel or reopen your ticket');
    const ok = (patch.status === 'canceled' && !isDone(type, ticket.status)) ||
      (type === 'incident' && ticket.status === 'resolved' && patch.status === 'in_progress');
    if (!ok) throw forbidden('That status change is not allowed');
  }
  for (const k of STAFF_FIELDS) if (k in patch && patch[k] !== undefined) changes[k] = patch[k];

  if (changes.details) changes.details = { ...ticket.details, ...changes.details };
  if ('assignee_id' in changes && changes.assignee_id !== null) {
    const u = await assertOwned(db, tenantId, 'users', changes.assignee_id, 'Assignee');
    if (u.role === 'requester') throw bad('Assignee must be an agent');
  }
  if ('group_id' in changes) await assertOwned(db, tenantId, 'groups', changes.group_id, 'Group');
  if ('company_id' in changes) await assertOwned(db, tenantId, 'companies', changes.company_id, 'Company');
  if ('requester_id' in changes) await assertOwned(db, tenantId, 'users', changes.requester_id, 'Requester');
  let ci = null;
  if ('ci_id' in changes) ci = await assertOwned(db, tenantId, 'cis', changes.ci_id, 'Configuration item');
  if ('problem_id' in changes && changes.problem_id !== null) {
    const p = await assertOwned(db, tenantId, 'tickets', changes.problem_id, 'Problem');
    if (p.type !== 'problem') throw bad('problem_id must reference a problem');
    if (type !== 'incident') throw bad('Only incidents can be linked to a problem');
  }

  const set = { ...changes };
  const now = new Date();
  const newStatus = changes.status ?? ticket.status;

  // Priority & SLA recalculation
  if ('impact' in changes || 'urgency' in changes) {
    set.priority = priorityFrom(changes.impact ?? ticket.impact, changes.urgency ?? ticket.urgency);
    if (set.priority !== ticket.priority && ['incident', 'request'].includes(type) && !ticket.resolved_at) {
      const sla = await slaTargets(db, tenantId, type, set.priority, ticket.created_at);
      set.response_due = sla.response_due; set.resolve_due = sla.resolve_due;
    }
  }

  if (type === 'change' && (changes.details || ci)) {
    const crit = ci?.criticality ?? (ticket.ci_id ? (await db.one('SELECT criticality FROM cis WHERE id=$1', [ticket.ci_id]))?.criticality : 3);
    set.details = { ...(set.details || ticket.details), ...assessChangeRisk(set.details || ticket.details, crit ?? 3) };
  }

  // Status transitions
  if (changes.status && changes.status !== ticket.status) {
    const to = changes.status;
    if (!canTransition(type, ticket.status, to)) throw bad(`Cannot move ${type} from ${ticket.status} to ${to}`);
    if (!system && (SYSTEM_ONLY[type] || []).includes(to) && !(type === 'change' && to === 'scheduled' && ticket.status === 'assess')) {
      throw bad(`${to} is set by the approval process`);
    }
    if (type === 'change' && ticket.status === 'assess' && to === 'scheduled') {
      const d = set.details || ticket.details;
      if (d.change_type !== 'standard') throw bad('Only standard (pre-approved) changes can skip CAB approval');
    }
    if (type === 'change' && to === 'scheduled') {
      const d = set.details || ticket.details;
      if (!d.planned_start || !d.planned_end) throw bad('Set planned start and end before scheduling');
    }
    if ((type === 'incident' && to === 'resolved') || (type === 'problem' && to === 'resolved')) {
      const code = changes.resolution_code ?? ticket.resolution_code;
      const notes = changes.resolution_notes ?? ticket.resolution_notes;
      if (!code || !notes) throw bad('Resolution code and notes are required to resolve');
    }
    if (isDone(type, to) && !ticket.resolved_at) set.resolved_at = now;
    if (!isDone(type, to) && ticket.resolved_at) { set.resolved_at = null; set.closed_at = null; }
    if (to === 'closed') set.closed_at = now;
    if (!ticket.responded_at && to !== LIFECYCLE[type].initial) set.responded_at = now;
    // SLA pause / resume: shift due dates by time spent paused
    if (isPaused(type, to) && !ticket.sla_paused_at) set.sla_paused_at = now;
    if (!isPaused(type, to) && ticket.sla_paused_at) {
      const shift = now - new Date(ticket.sla_paused_at);
      if (ticket.response_due && !ticket.responded_at) set.response_due = new Date(new Date(set.response_due || ticket.response_due).getTime() + shift);
      if (ticket.resolve_due) set.resolve_due = new Date(new Date(set.resolve_due || ticket.resolve_due).getTime() + shift);
      set.sla_paused_at = null;
    }
  }
  if ('assignee_id' in changes && changes.assignee_id && !ticket.responded_at) set.responded_at = now;

  const keys = Object.keys(set).filter((k) => JSON.stringify(set[k]) !== JSON.stringify(ticket[k]));
  if (!keys.length) return getTicket(db, tenantId, ticket.id);

  const cols = keys.map((k, i) => `${k} = $${i + 3}`).join(', ');
  const vals = keys.map((k) => (k === 'details' ? JSON.stringify(set[k]) : set[k]));
  await db.query(`UPDATE tickets SET ${cols}, updated_at = now() WHERE tenant_id = $1 AND id = $2`, [tenantId, ticket.id, ...vals]);

  for (const k of keys) {
    if (['responded_at', 'resolved_at', 'closed_at', 'sla_paused_at', 'response_due', 'resolve_due'].includes(k)) continue;
    await logEvent(db, actor, ticket, 'field', k, ticket[k], set[k]);
  }

  // Workflow side effects
  if (set.status === 'pending_approval') {
    const pending = { ...ticket, status: 'pending_approval' };
    if (type === 'change') await startApproval(db, actor, pending, null);
    if (type === 'request') {
      const item = ticket.catalog_item_id ? await db.one('SELECT approver_group_id FROM catalog_items WHERE id=$1', [ticket.catalog_item_id]) : null;
      await startApproval(db, actor, pending, item?.approver_group_id ?? null);
    }
  }
  if (type === 'problem' && set.status === 'resolved') await resolveLinkedIncidents(db, actor, ticket, changes.resolution_notes ?? ticket.resolution_notes);

  const updated = await getTicket(db, tenantId, ticket.id);
  if ('assignee_id' in set && set.assignee_id && (actor.kind !== 'user' || set.assignee_id !== actor.id)) {
    later(db, () => notifyUsers(tenantId, [set.assignee_id], updated, 'assigned', `${updated.number} assigned to you`));
  }
  if (set.status && updated.requester_id && updated.requester_id !== actor.id) {
    const rate = ['resolved', 'fulfilled'].includes(set.status) && ['incident', 'request'].includes(type) ? ' — tell us how we did' : '';
    later(db, () => notifyUsers(tenantId, [updated.requester_id], updated, 'status', `${updated.number} is now ${set.status.replace(/_/g, ' ')}${rate}`));
  }
  if (set.priority === 1 && ticket.priority !== 1 && type === 'incident') later(db, () => majorIncidentAlert(updated));
  return updated;
}

async function resolveLinkedIncidents(db, actor, problem, notes) {
  const incs = await db.many(`SELECT * FROM tickets WHERE tenant_id=$1 AND problem_id=$2 AND type='incident' AND resolved_at IS NULL`, [problem.tenant_id, problem.id]);
  for (const inc of incs) {
    await updateTicket(db, { kind: 'system', name: 'Problem Management', tenant_id: problem.tenant_id }, inc, {
      status: 'resolved', resolution_code: 'solved_permanently', resolution_notes: `Resolved by ${problem.number}: ${notes}`,
    }, { system: true });
  }
}

// Create approval records. Changes use CAB group members; requests use the catalog item's approver group.
async function startApproval(db, actor, ticket, groupId) {
  let approvers;
  if (groupId) approvers = await db.many('SELECT user_id FROM group_members WHERE group_id=$1', [groupId]);
  else approvers = await db.many(`SELECT DISTINCT gm.user_id FROM group_members gm JOIN groups g ON g.id = gm.group_id
      WHERE g.tenant_id = $1 AND g.is_cab`, [ticket.tenant_id]);
  const ids = approvers.map((a) => a.user_id).filter((id) => id !== ticket.requester_id || approvers.length === 1);
  if (!ids.length) throw bad(ticket.type === 'change' ? 'No CAB members configured. Mark a group as CAB and add members.' : 'No approvers configured for this item');
  if (ticket.status !== 'pending_approval') {
    await db.query(`UPDATE tickets SET status='pending_approval', sla_paused_at = COALESCE(sla_paused_at, now()), updated_at=now() WHERE id=$1`, [ticket.id]);
    await logEvent(db, actor, ticket, 'field', 'status', ticket.status, 'pending_approval');
  }
  await db.query(`UPDATE approvals SET state='canceled' WHERE ticket_id=$1 AND state='pending'`, [ticket.id]);
  for (const id of ids) {
    await db.query(`INSERT INTO approvals (tenant_id, ticket_id, approver_id) VALUES ($1,$2,$3)
      ON CONFLICT (ticket_id, approver_id) DO UPDATE SET state='pending', comment=NULL, decided_at=NULL`, [ticket.tenant_id, ticket.id, id]);
  }
  await logEvent(db, actor, ticket, 'approval', 'requested', null, `${ids.length} approver(s)`);
  later(db, () => notifyUsers(ticket.tenant_id, ids, ticket, 'approval', `Approval needed for ${ticket.number}`));
}

export async function decideApproval(db, actor, approvalId, decision, comment) {
  const ap = await db.one(`SELECT * FROM approvals WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [actor.tenant_id, approvalId]);
  if (!ap) throw notFound('Approval not found');
  if (ap.approver_id !== actor.id) throw forbidden('This approval is assigned to someone else');
  if (ap.state !== 'pending') throw bad('This approval has already been decided');
  if (decision === 'rejected' && !comment) throw bad('Please give a reason for rejecting');
  await db.query(`UPDATE approvals SET state=$2, comment=$3, decided_at=now() WHERE id=$1`, [ap.id, decision, comment || null]);

  const ticket = await db.one('SELECT * FROM tickets WHERE id=$1 FOR UPDATE', [ap.ticket_id]);
  await logEvent(db, actor, ticket, 'approval', decision, null, comment || null);
  const all = await db.many(`SELECT state FROM approvals WHERE ticket_id=$1 AND state <> 'canceled'`, [ticket.id]);
  const sys = { kind: 'system', name: 'Approval engine', tenant_id: ticket.tenant_id };
  const needsAll = ticket.type === 'change' && ticket.details?.change_type !== 'emergency';
  let outcome = null;
  if (all.some((a) => a.state === 'rejected')) outcome = 'rejected';
  else if (needsAll ? all.every((a) => a.state === 'approved') : all.some((a) => a.state === 'approved')) outcome = 'approved';

  if (outcome && ticket.status === 'pending_approval') {
    await db.query(`UPDATE approvals SET state='canceled' WHERE ticket_id=$1 AND state='pending'`, [ticket.id]);
    const to = outcome === 'rejected' ? 'rejected' : ticket.type === 'change' ? 'scheduled' : 'approved';
    if (to === 'scheduled' && (!ticket.details?.planned_start || !ticket.details?.planned_end)) {
      throw bad('Change needs a planned window before it can be approved');
    }
    await updateTicket(db, sys, ticket, { status: to }, { system: true });
    if (to === 'approved' && ticket.group_id) {
      later(db, () => notifyGroup(ticket.tenant_id, ticket.group_id, ticket, 'approved', `${ticket.number} approved and ready to fulfil`));
    }
  }
  return { approval: { ...ap, state: decision }, outcome };
}

export async function addComment(db, actor, ticket, body, internal) {
  const staff = isStaff(actor) || actor.kind === 'apikey';
  if (!staff) internal = false;
  const c = await db.one(`INSERT INTO ticket_comments (tenant_id, ticket_id, author_id, author_label, body, internal)
    VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [ticket.tenant_id, ticket.id, actor.kind === 'user' ? actor.id : null, actor.kind === 'user' ? null : actor.name, body, Boolean(internal)]);
  await db.query('UPDATE tickets SET updated_at = now() WHERE id=$1', [ticket.id]);
  if (staff && !internal && !ticket.responded_at) {
    await db.query('UPDATE tickets SET responded_at = now() WHERE id=$1', [ticket.id]);
  }
  // Requester replied to an on-hold incident: put it back in progress
  if (!staff && ticket.type === 'incident' && ticket.status === 'on_hold') {
    await updateTicket(db, { kind: 'system', name: 'Workflow', tenant_id: ticket.tenant_id }, ticket, { status: 'in_progress' }, { system: true });
  }
  if (staff && !internal && ticket.requester_id && ticket.requester_id !== actor.id) {
    later(db, () => notifyUsers(ticket.tenant_id, [ticket.requester_id], ticket, 'comment', `New update on ${ticket.number}`));
  } else if (!staff) {
    if (ticket.assignee_id) later(db, () => notifyUsers(ticket.tenant_id, [ticket.assignee_id], ticket, 'comment', `${ticket.number}: requester replied`));
    else later(db, () => notifyGroup(ticket.tenant_id, ticket.group_id, ticket, 'comment', `${ticket.number}: requester replied`));
  }
  return c;
}

// Detect other scheduled changes touching the same CI in an overlapping window
export async function changeConflicts(db, ticket) {
  const d = ticket.details || {};
  if (!ticket.ci_id || !d.planned_start || !d.planned_end) return [];
  return db.many(`SELECT id, number, title, details->>'planned_start' AS planned_start, details->>'planned_end' AS planned_end
    FROM tickets WHERE tenant_id=$1 AND type='change' AND id<>$2 AND ci_id=$3
      AND status IN ('pending_approval','scheduled','implementing')
      AND (details->>'planned_start')::timestamptz < $5::timestamptz AND (details->>'planned_end')::timestamptz > $4::timestamptz`,
  [ticket.tenant_id, ticket.id, ticket.ci_id, d.planned_start, d.planned_end]);
}
