// ITSM domain rules: lifecycles, priority matrix, SLA clock, numbering, change risk, approvals.

export const PREFIX = { incident: 'INC', request: 'REQ', problem: 'PRB', change: 'CHG', kb: 'KB' };

export const LIFECYCLE = {
  incident: {
    initial: 'new',
    transitions: {
      new: ['in_progress', 'on_hold', 'resolved', 'canceled'],
      in_progress: ['on_hold', 'resolved', 'canceled'],
      on_hold: ['in_progress', 'resolved', 'canceled'],
      resolved: ['closed', 'in_progress'],
      closed: [], canceled: [],
    },
    done: ['resolved', 'closed', 'canceled'], paused: ['on_hold'],
  },
  request: {
    initial: 'submitted',
    transitions: {
      submitted: ['in_progress', 'pending_approval', 'canceled'],
      pending_approval: ['approved', 'rejected', 'canceled'],
      approved: ['in_progress', 'canceled'],
      in_progress: ['fulfilled', 'canceled'],
      fulfilled: ['closed', 'in_progress'],
      rejected: [], closed: [], canceled: [],
    },
    done: ['fulfilled', 'closed', 'rejected', 'canceled'], paused: ['pending_approval'],
  },
  problem: {
    initial: 'new',
    transitions: {
      new: ['investigating', 'canceled'],
      investigating: ['known_error', 'resolved', 'canceled'],
      known_error: ['investigating', 'resolved'],
      resolved: ['closed', 'investigating'],
      closed: [], canceled: [],
    },
    done: ['resolved', 'closed', 'canceled'], paused: [],
  },
  change: {
    initial: 'draft',
    transitions: {
      draft: ['assess', 'canceled'],
      assess: ['pending_approval', 'scheduled', 'draft', 'canceled'],
      pending_approval: ['scheduled', 'rejected', 'canceled'],
      scheduled: ['implementing', 'canceled'],
      implementing: ['review'],
      review: ['closed'],
      rejected: ['draft'], closed: [], canceled: [],
    },
    done: ['closed', 'rejected', 'canceled'], paused: ['pending_approval'],
  },
};

// Statuses that only the system (approval engine) may set directly
export const SYSTEM_ONLY = { request: ['approved', 'rejected'], change: ['scheduled', 'rejected'] };

export function canTransition(type, from, to) {
  return from === to || (LIFECYCLE[type].transitions[from] || []).includes(to);
}
export const isDone = (type, status) => LIFECYCLE[type].done.includes(status);
export const isPaused = (type, status) => LIFECYCLE[type].paused.includes(status);

// ITIL impact × urgency matrix (1 = high). Result P1..P4.
export function priorityFrom(impact, urgency) {
  const s = impact + urgency;
  return s <= 2 ? 1 : s === 3 ? 2 : s === 4 ? 3 : 4;
}

export const DEFAULT_SLAS = [
  // type, priority, response mins, resolve mins
  ['incident', 1, 15, 240], ['incident', 2, 30, 480], ['incident', 3, 120, 1440], ['incident', 4, 480, 4320],
  ['request', 1, 60, 480], ['request', 2, 120, 1440], ['request', 3, 480, 2880], ['request', 4, 1440, 7200],
];

export async function nextNumber(db, tenantId, prefix) {
  const r = await db.one(`INSERT INTO counters (tenant_id, prefix, value) VALUES ($1, $2, 1001)
    ON CONFLICT (tenant_id, prefix) DO UPDATE SET value = counters.value + 1 RETURNING value`, [tenantId, prefix]);
  return `${prefix}${String(r.value).padStart(7, '0')}`;
}

export async function slaTargets(db, tenantId, type, priority, from = new Date()) {
  const p = await db.one('SELECT response_mins, resolve_mins FROM sla_policies WHERE tenant_id=$1 AND ticket_type=$2 AND priority=$3', [tenantId, type, priority]);
  if (!p) return { response_due: null, resolve_due: null };
  return {
    response_due: new Date(from.getTime() + p.response_mins * 60000),
    resolve_due: new Date(from.getTime() + p.resolve_mins * 60000),
  };
}

// Change risk: 0-100 score from change type, CI criticality and plan quality.
export function assessChangeRisk(details = {}, ciCriticality = 3) {
  let score = 10;
  if (details.change_type === 'emergency') score += 30;
  if (details.change_type === 'standard') score -= 10;
  score += (4 - ciCriticality) * 10;               // criticality 1 adds 30
  if (!details.backout_plan) score += 20;
  if (!details.test_plan) score += 10;
  if (details.outage_expected) score += 15;
  if (details.planned_start && details.planned_end) {
    const hrs = (new Date(details.planned_end) - new Date(details.planned_start)) / 3600000;
    if (hrs > 4) score += 10;
  }
  score = Math.max(0, Math.min(100, score));
  return { risk_score: score, risk: score >= 60 ? 'high' : score >= 35 ? 'moderate' : 'low' };
}

export const TICKET_TYPES = ['incident', 'request', 'problem', 'change'];
export const ALL_STATUSES = [...new Set(Object.values(LIFECYCLE).flatMap((l) => Object.keys(l.transitions)))];
export const RESOLUTION_CODES = ['solved_permanently', 'workaround', 'auto_remediated', 'duplicate', 'user_error', 'no_fault_found', 'not_reproducible'];
export const CATEGORIES = ['Hardware', 'Software', 'Network', 'Access', 'Email', 'Security', 'Database', 'Cloud', 'Printing', 'Other'];
