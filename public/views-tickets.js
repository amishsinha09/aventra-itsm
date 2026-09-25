import {
  fresh, html, raw, get, post, patch, on, toast, fail, modal, formData, esc, label, initials, timeAgo, dt, dur, toLocalInput,
  priorityBadge, statusBadge, slaInfo, TYPE_LABEL, options, md,
} from './lib.js';
import { state, isStaff, lookup, go, refreshBadges } from './app.js';

const SOURCE_TAG = { aventra: html`<span class="tag auto">⚡ Aventra</span>`, email: html`<span class="tag">✉ Email</span>`, api: html`<span class="tag">API</span>` };

export function ticketTable(rows, { empty = 'No tickets match.', showType = false } = {}) {
  if (!rows.length) return html`<div class="table-wrap"><div class="empty">${empty}</div></div>`;
  const staff = isStaff();
  return html`<div class="table-wrap"><table><thead><tr>
    <th>Number</th><th>Title</th><th>Priority</th><th>Status</th>${staff ? html`<th>Assigned</th><th>Company</th>` : ''}<th>SLA</th><th>Updated</th></tr></thead>
    <tbody>${rows.map((t) => html`<tr class="clickable" data-href="#/tickets/${t.id}">
      <td class="nowrap"><a href="#/tickets/${t.id}"><strong>${t.number}</strong></a>${showType ? html`<div class="small faint">${TYPE_LABEL[t.type]}</div>` : ''}</td>
      <td><div class="title">${t.title}</div><div class="small faint">${t.category || ''}${t.ci_name ? ` · ${t.ci_name}` : ''} ${t.source && SOURCE_TAG[t.source] ? SOURCE_TAG[t.source] : ''} ${t.auto_remediated ? html`<span class="tag auto">self-healed</span>` : ''}</div></td>
      <td>${priorityBadge(t.priority)}</td><td>${statusBadge(t.status)}</td>
      ${staff ? html`<td class="nowrap">${t.assignee_name ? t.assignee_name : html`<span class="faint">${t.group_name || 'Unassigned'}</span>`}</td><td class="small">${t.company_name || ''}</td>` : ''}
      <td>${slaInfo(t) || html`<span class="faint">—</span>`}</td><td class="small muted nowrap">${timeAgo(t.updated_at)}</td></tr>`)}</tbody></table></div>`;
}

export async function ticketListView(el, type) {
  const mine = type === 'mine';
  const q = state.query;
  const f = { status: q.get('status') || '', priority: q.get('priority') || '', assignee: q.get('assignee') || '', group: q.get('group') || '',
    q: q.get('q') || '', ci: q.get('ci') || '', problem: q.get('problem') || '', category: q.get('category') || '', open: q.get('open') ?? (mine ? '' : 'true'), breached: q.get('breached') || '', source: q.get('source') || '', sort: q.get('sort') || 'newest', page: +(q.get('page') || 1) };
  const [groups, users] = mine ? [[], []] : await Promise.all([lookup('groups'), lookup('users')]);
  const statuses = mine ? [] : Object.keys(state.meta.transitions[type]);

  async function load() {
    const p = new URLSearchParams();
    if (!mine) p.set('type', type);
    for (const [k, v] of Object.entries(f)) if (v !== '' && v != null) p.set(k, v);
    const r = await get(`/api/tickets?${p}&limit=25`);
    const pages = Math.max(1, Math.ceil(r.total / r.limit));
    el.querySelector('#results').innerHTML = String(html`${ticketTable(r.rows, { showType: mine })}
      <div class="pager"><span class="small">${r.total} ticket${r.total === 1 ? '' : 's'}</span>
      <span class="btn-row"><button class="btn sm" data-page="${f.page - 1}" ${f.page <= 1 ? raw('disabled') : ''}>← Prev</button><span class="small">Page ${f.page} of ${pages}</span><button class="btn sm" data-page="${f.page + 1}" ${f.page >= pages ? raw('disabled') : ''}>Next →</button></span></div>`);
    const qs = new URLSearchParams(Object.entries(f).filter(([k, v]) => v !== '' && !(k === 'page' && v === 1) && !(k === 'sort' && v === 'newest')));
    history.replaceState(null, '', `#/${mine ? 'my' : `list/${type}`}${qs.toString() ? `?${qs}` : ''}`);
  }

  el.innerHTML = String(html`
    <div class="page-head"><div><h1>${mine ? 'My tickets' : `${TYPE_LABEL[type]}s`}</h1><p>${mine ? 'Everything you have raised with IT.' : { incident: 'Unplanned interruptions and degradations.', request: 'Service catalog orders and standard requests.', problem: 'Root causes behind recurring incidents.', change: 'Planned changes with risk assessment and CAB approval.' }[type]}</p></div>
      <div class="btn-row">${!mine ? html`<a class="btn" href="/api/tickets/export.csv?type=${type}" download>Export CSV</a>` : ''}<a class="btn primary" href="${mine ? '#/new/incident' : `#/new/${type}`}">${mine ? 'Report an issue' : `New ${type}`}</a></div></div>
    <form class="filters" id="filters">
      <input type="search" name="q" placeholder="Search…" value="${f.q}">
      ${!mine ? html`
      <div class="seg" role="group" aria-label="Open or closed">${[['true', 'Open'], ['false', 'Closed'], ['', 'All']].map(([v, t]) => html`<button type="button" data-open="${v}" class="${f.open === v ? 'on' : ''}">${t}</button>`)}</div>
      <select name="status">${options(statuses, f.status, { blank: 'Any status' })}</select>
      <select name="priority">${options([[1, 'P1 Critical'], [2, 'P2 High'], [3, 'P3 Moderate'], [4, 'P4 Low']], f.priority, { blank: 'Any priority' })}</select>
      <select name="assignee">${options([['me', 'Assigned to me'], ['none', 'Unassigned'], ...users.map((u) => [u.id, u.name])], f.assignee, { blank: 'Anyone' })}</select>
      <select name="group">${options([['mine', 'My groups'], ...groups.map((g) => [g.id, g.name])], f.group, { blank: 'Any group' })}</select>
      ${type === 'incident' ? html`<select name="source">${options([['aventra', 'Aventra agent'], ['portal', 'Portal'], ['email', 'Email'], ['agent', 'Agent'], ['api', 'API']], f.source, { blank: 'Any source' })}</select>
      <label class="check"><input type="checkbox" name="breached" ${f.breached ? raw('checked') : ''}> SLA breached</label>` : ''}
      <select name="sort">${options([['newest', 'Newest'], ['priority', 'Priority'], ['due', 'SLA due'], ['updated', 'Recently updated'], ['oldest', 'Oldest']], f.sort)}</select>` : ''}
    </form>
    <div id="results"><div class="empty faint">Loading…</div></div>`);

  const form = el.querySelector('#filters');
  let t;
  const apply = () => { const d = formData(form); Object.assign(f, { ...d, breached: d.breached ? 'true' : '', page: 1 }); load().catch(fail); };
  form.addEventListener('change', apply);
  form.addEventListener('input', (e) => { if (e.target.name === 'q') { clearTimeout(t); t = setTimeout(apply, 300); } });
  form.addEventListener('submit', (e) => { e.preventDefault(); apply(); });
  on(el, 'click', '[data-open]', (b) => { f.open = b.dataset.open; f.page = 1; el.querySelectorAll('[data-open]').forEach((x) => x.classList.toggle('on', x === b)); load().catch(fail); });
  on(el, 'click', '[data-page]', (b) => { f.page = +b.dataset.page; load().catch(fail); });
  on(el, 'click', 'tr[data-href]', (tr, e) => { if (!e.target.closest('a')) location.hash = tr.dataset.href; });
  await load();
}

// ---------------------------------------------------------------- New ticket
export async function ticketNewView(el, type) {
  const staff = isStaff();
  if (!staff && !['incident', 'request'].includes(type)) { location.hash = '#/home'; return; }
  if (!staff && type === 'request') { location.hash = '#/catalog'; return; }
  const [groups, users, companies, cis, requesters] = staff
    ? await Promise.all([lookup('groups'), lookup('users'), lookup('companies'), lookup('cis'), lookup('allUsers')]) : [[], [], [], [], []];
  const preCi = state.query.get('ci');
  const start = new Date(Date.now() + 86400000 * 2); start.setHours(22, 0, 0, 0);
  const ciSelect = html`<select name="ci_id" data-type="int">${options(cis.map((c) => [c.id, `${c.name} (${c.ci_class})`]), preCi, { blank: '— none —' })}</select>`;

  el.innerHTML = String(html`<div class="page-head"><div><h1>${staff ? `New ${type}` : 'Report an issue'}</h1>
    <p>${staff ? { incident: 'Log an interruption. Priority is calculated from impact × urgency.', request: 'Log a request on behalf of a user. For catalog items, use the Service catalog.', problem: 'Track the root cause behind one or more incidents.', change: 'Plan a change. Risk is scored automatically from the CI, plan and window.' }[type] : "Tell us what's wrong. We'll triage it and keep you updated by email."}</p></div></div>
  <form class="split" id="f" novalidate>
    <div class="card">
      <div class="field"><label for="title">${staff ? 'Short description' : 'What do you need help with?'}</label><input id="title" name="title" maxlength="200" required placeholder="${type === 'change' ? 'e.g. Upgrade firmware on core switch' : 'e.g. Outlook keeps asking for my password'}"></div>
      <div class="field"><label for="description">Details</label><textarea id="description" name="description" rows="6" placeholder="${staff ? '' : 'When did it start? Who is affected? Any error messages?'}"></textarea></div>
      <div id="kbHint"></div>
      ${type === 'change' ? html`<div class="divider"></div><h3 style="margin-bottom:10px">Change plan</h3>
        <div class="grid g2"><div class="field"><label>Change type</label><select name="change_type">${options([['normal', 'Normal (CAB approval)'], ['standard', 'Standard (pre-approved)'], ['emergency', 'Emergency (expedited)']], 'normal')}</select></div>
          <div class="field"><label class="check" style="margin-top:26px"><input type="checkbox" name="outage_expected"> Service outage expected</label></div>
          <div class="field"><label>Planned start</label><input type="datetime-local" name="planned_start" value="${toLocalInput(start)}"></div>
          <div class="field"><label>Planned end</label><input type="datetime-local" name="planned_end" value="${toLocalInput(new Date(start.getTime() + 7200000))}"></div></div>
        <div class="field"><label>Implementation plan</label><textarea name="implementation_plan" rows="3"></textarea></div>
        <div class="field"><label>Backout plan</label><textarea name="backout_plan" rows="2"></textarea><div class="hint">Changes without a backout plan score higher risk.</div></div>
        <div class="field"><label>Test plan</label><textarea name="test_plan" rows="2"></textarea></div>` : ''}
      <div class="btn-row"><button class="btn primary" type="submit">${staff ? `Create ${type}` : 'Submit'}</button><a class="btn" href="${staff ? `#/list/${type}` : '#/home'}">Cancel</a></div>
    </div>
    ${staff ? html`<div class="card side-panel stack">
      <div class="grid g2"><div class="field"><label>Impact</label><select name="impact" data-type="int">${options([[1, '1 – High'], [2, '2 – Medium'], [3, '3 – Low']], type === 'change' ? 2 : 3)}</select></div>
      <div class="field"><label>Urgency</label><select name="urgency" data-type="int">${options([[1, '1 – High'], [2, '2 – Medium'], [3, '3 – Low']], 3)}</select></div></div>
      <div class="small muted" id="prio"></div>
      <div class="field"><label>Category</label><select name="category">${options(state.meta.categories.map((c) => [c, c]), '', { blank: 'Auto-detect' })}</select></div>
      <div class="field"><label>Requester</label><select name="requester_id" data-type="int">${options(requesters.map((u) => [u.id, `${u.name}${u.company_name ? ` · ${u.company_name}` : ''}`]), state.me.user.id)}</select></div>
      <div class="field"><label>Company</label><select name="company_id" data-type="int">${options(companies, '', { blank: "Requester's company" })}</select></div>
      <div class="field"><label>Configuration item</label>${ciSelect}</div>
      <div class="field"><label>Assignment group</label><select name="group_id" data-type="int">${options(groups, '', { blank: 'Auto-route by category' })}</select></div>
      <div class="field"><label>Assigned to</label><select name="assignee_id" data-type="int">${options(users, '', { blank: 'Unassigned' })}</select></div>
    </div>` : html`<div class="card"><h2>What happens next</h2><ol class="muted" style="padding-left:18px;margin-bottom:0"><li>We triage your ticket and route it to the right team.</li><li>You'll get an email when someone picks it up.</li><li>Reply to any email to add details.</li></ol></div>`}
  </form>`);

  const form = el.querySelector('#f');
  const prio = () => { const i = +form.impact?.value; const u = +form.urgency?.value; if (!i) return; const s = i + u; const p = s <= 2 ? 1 : s === 3 ? 2 : s === 4 ? 3 : 4; el.querySelector('#prio').innerHTML = String(html`Priority: ${priorityBadge(p)}`); };
  prio(); form.addEventListener('change', prio);

  // Deflection: suggest KB articles while the user types
  let timer;
  form.title.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = form.title.value.trim(); if (q.length < 4 || type === 'change') return;
      const kb = await get(`/api/kb?q=${encodeURIComponent(q)}`).catch(() => []);
      el.querySelector('#kbHint').innerHTML = String(kb.length ? html`<div class="ai-box" style="margin-bottom:14px"><div class="ai-label">These articles might solve it</div>
        <div class="list-links">${kb.slice(0, 3).map((k) => html`<a href="#/kb/${k.id}" target="_blank">${k.title}</a>`)}</div></div>` : '');
    }, 400);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(form);
    const body = { type, title: d.title, description: d.description };
    if (staff) for (const k of ['impact', 'urgency', 'category', 'requester_id', 'company_id', 'ci_id', 'group_id', 'assignee_id']) if (d[k] !== '' && d[k] != null) body[k] = d[k];
    if (type === 'change') body.details = { change_type: d.change_type, planned_start: d.planned_start, planned_end: d.planned_end, outage_expected: d.outage_expected,
      implementation_plan: d.implementation_plan, backout_plan: d.backout_plan, test_plan: d.test_plan };
    try {
      const t = await post('/api/tickets', body);
      state.cache.problems = undefined;
      toast(`${t.number} created`);
      location.hash = `#/tickets/${t.id}`;
    } catch (err) { fail(err); }
  });
  form.title.focus();
}

// ---------------------------------------------------------------- Detail
const ACTION_LABEL = {
  in_progress: 'Start work', on_hold: 'Put on hold', resolved: 'Resolve', closed: 'Close', canceled: 'Cancel', investigating: 'Start investigation',
  known_error: 'Mark known error', assess: 'Submit for assessment', pending_approval: 'Request approval', scheduled: 'Schedule', implementing: 'Start implementation',
  review: 'Complete implementation', fulfilled: 'Mark fulfilled', draft: 'Back to draft', approved: 'Approve', rejected: 'Reject',
};
const SYSTEM_ONLY = { request: ['approved', 'rejected'], change: ['rejected'] };

export async function ticketDetailView(el, id) {
  const d = await get(`/api/tickets/${id}`);
  const t = d.ticket; const staff = isStaff();
  const [groups, users, companies, cis, problems] = staff ? await Promise.all([lookup('groups'), lookup('users'), lookup('companies'), lookup('cis'), lookup('problems')]) : [[], [], [], [], []];

  const actions = (d.transitions || []).filter((s) => !(SYSTEM_ONLY[t.type] || []).includes(s))
    .filter((s) => !(t.type === 'change' && s === 'scheduled' && (t.status !== 'assess' || t.details.change_type !== 'standard')));
  const reqActions = !staff ? [
    ...(t.status !== 'canceled' && !['resolved', 'closed', 'fulfilled', 'rejected'].includes(t.status) ? [['canceled', 'Cancel my ticket']] : []),
    ...(t.type === 'incident' && t.status === 'resolved' ? [['in_progress', "It's not fixed — reopen"]] : []),
  ] : [];

  const timeline = [...d.comments.map((c) => ({ ...c, _k: 'c' })), ...d.events.filter((e) => e.kind !== 'created').map((e) => ({ ...e, _k: 'e' }))]
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at) || (a._k === 'e' ? -1 : 1));
  const eventText = (e) => {
    const who = e.actor_name || e.actor_label || 'System';
    if (e.kind === 'field') {
      const find = (list, v, key = 'name') => list.find((x) => String(x.id) === v)?.[key];
      const fmt = (f, v) => {
        if (v == null || v === '') return '—';
        if (['assignee_id', 'requester_id'].includes(f)) return find(users, v) || 'another user';
        if (f === 'group_id') return find(groups, v) || 'a group';
        if (f === 'company_id') return find(companies, v) || 'a company';
        if (f === 'ci_id') return find(cis, v) || (String(t.ci_id) === v ? t.ci_name : 'a CI');
        if (f === 'problem_id') return find(problems, v, 'number') || (String(t.problem_id) === v ? t.problem_number : 'a problem');
        if (['impact', 'urgency', 'priority'].includes(f)) return v;
        return label(v);
      };
      const FIELD = { ci_id: 'configuration item', problem_id: 'problem', group_id: 'group', assignee_id: 'assignee', company_id: 'company', requester_id: 'requester', resolution_code: 'resolution code' };
      const name = FIELD[e.field] || label(e.field).toLowerCase();
      if (['details', 'description', 'resolution_notes', 'title'].includes(e.field)) return `${who} updated the ${name}`;
      return `${who} changed ${name} from ${fmt(e.field, e.old_value)} to ${fmt(e.field, e.new_value)}`;
    }
    if (e.kind === 'approval') return e.field === 'requested' ? `${who} requested approval (${e.new_value})` : `${who} ${e.field} ${e.new_value ? `— “${e.new_value}”` : ''}`;
    if (e.kind === 'sla') return `SLA ${e.new_value} target breached`;
    if (e.kind === 'csat') return `${who} rated this ticket ${e.new_value}`;
    return `${who}: ${e.kind}`;
  };

  const det = t.details || {};
  const typeCard = t.type === 'change' ? html`<div class="card"><div class="card-head"><h2>Change plan</h2>${staff && !['closed', 'canceled'].includes(t.status) ? html`<button class="btn sm" data-act="edit-plan">Edit plan</button>` : ''}</div>
      <div class="grid g3" style="margin-bottom:12px">
        <div><div class="small muted">Type</div><strong>${label(det.change_type)}</strong></div>
        <div><div class="small muted">Risk</div><strong class="risk-${det.risk}">${label(det.risk)} (${det.risk_score}/100)</strong><div class="meter"><span style="width:${det.risk_score}%;background:var(--${det.risk === 'high' ? 'critical' : det.risk === 'moderate' ? 'serious' : 'good'})"></span></div></div>
        <div><div class="small muted">Window</div><strong>${dt(det.planned_start)}</strong><div class="small muted">→ ${dt(det.planned_end)}${det.outage_expected ? ' · outage expected' : ''}</div></div></div>
      ${d.conflicts.length ? html`<div class="ai-box" style="border-color:var(--critical);background:var(--critical-soft);margin-bottom:12px"><strong style="color:var(--critical)">⚠ Schedule conflict</strong> — overlaps ${d.conflicts.map((c) => html`<a href="#/tickets/${c.id}">${c.number}</a> `)} on the same CI.</div>` : ''}
      ${[['Implementation plan', det.implementation_plan], ['Backout plan', det.backout_plan], ['Test plan', det.test_plan]].map(([k, v]) => html`<div style="margin-bottom:10px"><h3>${k}</h3><div class="desc">${v || html`<span class="faint">Not provided</span>`}</div></div>`)}</div>`
    : t.type === 'problem' ? html`<div class="card"><div class="card-head"><h2>Root cause analysis</h2>${staff ? html`<button class="btn sm" data-act="edit-rca">Edit</button>` : ''}</div>
      <div class="grid g2"><div><h3>Root cause</h3><div class="desc">${det.root_cause || html`<span class="faint">Not yet identified</span>`}</div></div><div><h3>Workaround</h3><div class="desc">${det.workaround || html`<span class="faint">None documented</span>`}</div></div></div>
      <div class="divider"></div><h3 style="margin-bottom:6px">Linked incidents (${d.linked.length})</h3>
      ${d.linked.length ? html`<div class="list-links">${d.linked.map((i) => html`<a href="#/tickets/${i.id}"><strong>${i.number}</strong> ${i.title} ${statusBadge(i.status)}</a>`)}</div>` : html`<div class="small faint">Link incidents from the incident's side panel. Resolving this problem resolves linked open incidents.</div>`}</div>`
      : t.type === 'request' && det.variables && Object.keys(det.variables).length ? html`<div class="card"><h2 style="margin-bottom:10px">${t.catalog_item_name || 'Request details'}</h2>
      <div class="kv">${Object.entries(det.variables).map(([k, v]) => html`<div>${label(k)}</div><div>${String(v)}</div>`)}</div></div>` : '';

  const myApproval = d.approvals.find((a) => a.approver_id === state.me.user.id && a.state === 'pending');

  el.innerHTML = String(html`
    <div class="ticket-head"><div style="min-width:0;flex:1">
      <div class="meta"><a href="${staff ? `#/list/${t.type}` : '#/my'}">${TYPE_LABEL[t.type]}s</a> / <strong>${t.number}</strong> ${statusBadge(t.status)} ${priorityBadge(t.priority)} ${SOURCE_TAG[t.source] || ''} ${t.auto_remediated ? html`<span class="tag auto">self-healed</span>` : ''}</div>
      <h1>${t.title}</h1>
      <div class="small muted" style="margin-top:4px">Opened ${timeAgo(t.created_at)} by ${t.requester_name || 'system'}${t.company_name ? ` · ${t.company_name}` : ''}</div></div>
      <div class="btn-row">
        ${staff && !t.assignee_id && !t.resolved_at ? html`<button class="btn" data-act="take">Assign to me</button>` : ''}
        ${staff ? actions.map((s) => html`<button class="btn ${['resolved', 'fulfilled', 'closed'].includes(s) ? 'good' : s === 'canceled' ? 'danger' : ''}" data-status="${s}">${ACTION_LABEL[s] || label(s)}</button>`) : ''}
        ${reqActions.map(([s, l]) => html`<button class="btn ${s === 'canceled' ? 'danger' : ''}" data-status="${s}">${l}</button>`)}
        ${staff && t.resolved_at && ['incident', 'problem', 'request'].includes(t.type) ? html`<button class="btn" data-act="kb">Create KB article</button>` : ''}
      </div></div>

    ${myApproval ? html`<div class="ai-box" style="margin-bottom:14px;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap"><div><div class="ai-label">Your approval is needed</div>${t.type === 'change' ? `Review the plan and risk below.` : 'Review the request details below.'}</div>
      <div class="btn-row"><button class="btn danger" data-decide="rejected" data-id="${myApproval.id}">Reject</button><button class="btn good" data-decide="approved" data-id="${myApproval.id}">Approve</button></div></div>` : ''}

    ${csatBlock(t, staff)}
    <div class="${staff ? 'split' : ''}">
      <div class="stack">
        <div class="card"><div class="card-head"><h2>Description</h2>${staff ? html`<button class="btn sm ghost" data-act="edit-desc">Edit</button>` : ''}</div><div class="desc">${t.description || html`<span class="faint">No description</span>`}</div>
          ${t.resolution_notes ? html`<div class="divider"></div><h3>Resolution · ${label(t.resolution_code)}</h3><div class="desc" style="margin-top:4px">${t.resolution_notes}</div>` : ''}</div>
        ${typeCard}
        ${d.approvals.length ? html`<div class="card"><h2 style="margin-bottom:8px">Approvals</h2>${d.approvals.map((a) => html`<div class="approval"><span><span class="avatar sm" style="display:inline-grid;vertical-align:middle;margin-right:6px">${initials(a.approver_name)}</span>${a.approver_name}${a.comment ? html` <span class="small muted">— “${a.comment}”</span>` : ''}</span>${statusBadge(a.state === 'pending' ? 'pending_approval' : a.state)}</div>`)}</div>` : ''}
        ${staff ? html`<div class="card" id="aiCard"><div class="card-head"><h2>AI assist</h2><button class="btn sm" data-act="ai">✦ Draft reply & fix</button></div>
          ${t.ai?.triage ? html`<div class="small muted">Triage (${t.ai.triage.engine === 'claude' ? 'Claude' : 'rules'}): <strong>${t.ai.triage.category}</strong>, suggested impact ${t.ai.triage.impact} / urgency ${t.ai.triage.urgency}. ${t.ai.triage.summary && t.ai.triage.engine === 'claude' ? `“${t.ai.triage.summary}”` : ''}</div>` : ''}
          <div id="aiOut"></div></div>` : ''}
        <div class="card"><h2 style="margin-bottom:6px">Activity</h2>
          <div class="timeline">${timeline.length ? timeline.map((x) => x._k === 'e'
    ? html`<div class="entry event">• ${eventText(x)} <span class="faint">· ${timeAgo(x.created_at)}</span></div>`
    : html`<div class="entry ${x.internal ? 'internal' : ''}"><span class="avatar sm ${x.author_label ? 'bot' : ''}">${x.author_label ? '⚡' : initials(x.author_name)}</span><div class="body">
        <div class="small"><strong>${x.author_name || x.author_label}</strong> ${x.internal ? html`<span class="tag">Internal note</span>` : ''} <span class="faint">· ${timeAgo(x.created_at)}</span></div>
        <div class="bubble">${x.body}</div></div></div>`) : html`<div class="small faint" style="padding:8px 0">No activity yet.</div>`}</div>
          ${!['closed', 'canceled'].includes(t.status) ? html`<form class="composer" id="composer" style="margin-top:10px">
            <textarea name="body" placeholder="${staff ? 'Reply to the requester, or add an internal note…' : 'Add a comment or more details…'}" required></textarea>
            <div class="bar">${staff ? html`<div class="seg"><button type="button" data-mode="public" class="on">Reply</button><button type="button" data-mode="internal">Internal note</button></div>` : html`<span></span>`}
              <button class="btn primary sm" type="submit">${staff ? 'Send' : 'Add comment'}</button></div></form>` : ''}
        </div>
      </div>
      ${staff ? html`<aside class="side-panel stack">
        <form class="card" id="fields"><div class="card-head"><h2>Details</h2><button class="btn sm primary hidden" type="submit" id="saveFields">Save</button></div>
          <div class="field"><label>Assignment group</label><select name="group_id" data-type="int">${options(groups, t.group_id, { blank: '— none —' })}</select></div>
          <div class="field"><label>Assigned to</label><select name="assignee_id" data-type="int">${options(users, t.assignee_id, { blank: 'Unassigned' })}</select></div>
          <div class="grid g2"><div class="field"><label>Impact</label><select name="impact" data-type="int">${options([[1, '1 – High'], [2, '2 – Medium'], [3, '3 – Low']], t.impact)}</select></div>
          <div class="field"><label>Urgency</label><select name="urgency" data-type="int">${options([[1, '1 – High'], [2, '2 – Medium'], [3, '3 – Low']], t.urgency)}</select></div></div>
          <div class="field"><label>Category</label><select name="category">${options(state.meta.categories.map((c) => [c, c]), t.category, { blank: '—' })}</select></div>
          <div class="field"><label>Company</label><select name="company_id" data-type="int">${options(companies, t.company_id, { blank: '— none —' })}</select></div>
          <div class="field"><label>Configuration item</label><select name="ci_id" data-type="int">${options(cis.map((c) => [c.id, c.name]), t.ci_id, { blank: '— none —' })}</select>${t.ci_id ? html`<div class="hint"><a href="#/cmdb/${t.ci_id}">Open ${t.ci_name} →</a></div>` : ''}</div>
          ${t.type === 'incident' ? html`<div class="field"><label>Problem</label><select name="problem_id" data-type="int">${options(problems.map((p) => [p.id, `${p.number} ${p.title.slice(0, 40)}`]).concat(t.problem_id && !problems.some((p) => p.id === t.problem_id) ? [[t.problem_id, t.problem_number]] : []), t.problem_id, { blank: '— none —' })}</select>
            <div class="hint"><a href="#" data-act="new-problem">Create problem from this incident</a></div></div>` : ''}
        </form>
        ${t.resolve_due || t.response_due ? html`<div class="card"><h2 style="margin-bottom:10px">SLA</h2><div class="kv">
          <div>Response</div><div class="small">${t.responded_at ? html`<span class="sla ok">✓ ${dt(t.responded_at)}</span>` : html`due ${dt(t.response_due)}`}</div>
          <div>Resolution</div><div class="small">${slaInfo(t)}<br><span class="faint">due ${dt(t.resolve_due)}</span></div></div></div>` : ''}
        <div class="card"><h2 style="margin-bottom:6px">Suggested knowledge</h2>
          ${d.suggestions.kb.length ? html`<div class="list-links">${d.suggestions.kb.map((k) => html`<a href="#/kb/${k.id}">📖 ${k.title}</a>`)}</div>` : html`<div class="small faint">No matching articles.</div>`}
          ${d.suggestions.similar.length ? html`<h3 style="margin:12px 0 4px">Similar resolved</h3><div class="list-links">${d.suggestions.similar.map((s) => html`<a href="#/tickets/${s.id}" title="${s.resolution_notes}"><strong>${s.number}</strong> ${s.title}</a>`)}</div>` : ''}</div>
        <div class="card small"><div class="kv"><div>Requester</div><div>${t.requester_name || '—'}${t.requester_email ? html`<br><span class="faint">${t.requester_email}</span>` : ''}</div><div>Created</div><div>${dt(t.created_at)}</div><div>Updated</div><div>${dt(t.updated_at)}</div>${t.external_ref ? html`<div>External ref</div><div><code>${t.external_ref}</code></div>` : ''}</div></div>
      </aside>` : ''}
    </div>`);

  const reload = () => ticketDetailView(fresh(el), id);
  const csatForm = el.querySelector('#csat');
  if (csatForm) {
    let score = 0;
    on(csatForm, 'click', '[data-star]', (b) => { score = +b.dataset.star; csatForm.querySelectorAll('[data-star]').forEach((x) => x.classList.toggle('on', +x.dataset.star <= score)); csatForm.querySelector('.csat-more').classList.remove('hidden'); });
    csatForm.addEventListener('submit', async (e) => {
      e.preventDefault(); if (!score) return;
      try { await post(`/api/tickets/${t.id}/csat`, { score, comment: csatForm.comment.value }); toast('Thanks for your feedback!'); reload(); } catch (err) { fail(err); }
    });
  }
  const update = async (body, msg) => { try { await patch(`/api/tickets/${t.id}`, body); if (msg) toast(msg); state.cache.problems = undefined; await reload(); } catch (e) { fail(e); } };

  on(el, 'click', '[data-status]', async (b) => {
    const s = b.dataset.status;
    if (s === 'resolved' && ['incident', 'problem'].includes(t.type)) {
      const r = await modal({ title: `Resolve ${t.number}`, submit: 'Resolve',
        body: html`<div class="field"><label>Resolution code</label><select name="resolution_code">${options(state.meta.resolutionCodes.map((c) => [c, label(c)]), 'solved_permanently')}</select></div>
          <div class="field"><label>Resolution notes</label><textarea name="resolution_notes" rows="4" required placeholder="What fixed it? Visible to the requester.">${d.suggestions.similar[0] && !t.resolution_notes ? '' : t.resolution_notes || ''}</textarea></div>
          ${t.type === 'problem' && d.linked.some((i) => !['resolved', 'closed', 'canceled'].includes(i.status)) ? html`<div class="hint">Open linked incidents will be resolved too.</div>` : ''}` });
      if (r) update({ status: 'resolved', ...r }, `${t.number} resolved`);
      return;
    }
    if (s === 'canceled' && !(await modal({ title: 'Cancel this ticket?', body: html`<p>This can't be undone.</p>`, submit: 'Cancel ticket', danger: true }))) return;
    update({ status: s }, `${t.number}: ${label(s)}`);
  });
  on(el, 'click', '[data-act=take]', () => update({ assignee_id: state.me.user.id, ...(['new', 'submitted'].includes(t.status) ? { status: 'in_progress' } : {}) }, 'Assigned to you'));
  on(el, 'click', '[data-decide]', async (b) => {
    const decision = b.dataset.decide;
    const r = await modal({ title: decision === 'approved' ? 'Approve' : 'Reject', submit: decision === 'approved' ? 'Approve' : 'Reject', danger: decision === 'rejected',
      body: html`<div class="field"><label>Comment${decision === 'rejected' ? ' (required)' : ' (optional)'}</label><textarea name="comment" rows="3"></textarea></div>` });
    if (!r) return;
    try { const out = await post(`/api/approvals/${b.dataset.id}`, { decision, comment: r.comment }); toast(out.outcome ? `Ticket ${out.outcome}` : 'Decision recorded'); refreshBadges(); reload(); } catch (e) { fail(e); }
  });

  const fields = el.querySelector('#fields');
  if (fields) {
    fields.addEventListener('change', () => el.querySelector('#saveFields').classList.remove('hidden'));
    fields.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = formData(fields); const body = {};
      for (const [k, v] of Object.entries(f)) { const cur = t[k] ?? null; const nv = v === '' ? null : v; if (String(cur ?? '') !== String(nv ?? '')) body[k] = nv; }
      if (Object.keys(body).length) update(body, 'Saved');
    });
  }

  const composer = el.querySelector('#composer');
  if (composer) {
    let internal = false;
    on(composer, 'click', '[data-mode]', (b) => { internal = b.dataset.mode === 'internal'; composer.classList.toggle('internal', internal); composer.querySelectorAll('[data-mode]').forEach((x) => x.classList.toggle('on', x === b)); });
    composer.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = composer.body.value.trim(); if (!body) return;
      try { await post(`/api/tickets/${t.id}/comments`, { body, internal }); await reload(); } catch (err) { fail(err); }
    });
  }

  on(el, 'click', '[data-act=ai]', async (b) => {
    b.disabled = true; b.textContent = 'Thinking…';
    try {
      const r = await post(`/api/tickets/${t.id}/ai/draft`);
      el.querySelector('#aiOut').innerHTML = String(html`<div class="ai-box" style="margin-top:10px">
        ${r.resolution_hint ? html`<div class="ai-label">Likely fix</div><div class="desc" style="margin-bottom:10px">${r.resolution_hint}</div>` : ''}
        <div class="ai-label">Draft reply ${r.engine === 'rules' ? html`<span class="faint" style="text-transform:none;font-weight:500">(template — add ANTHROPIC_API_KEY for AI drafts)</span>` : ''}</div>
        <div class="desc">${r.reply}</div><div class="btn-row" style="margin-top:8px"><button class="btn sm" data-act="use-draft">Use as reply</button></div></div>`);
      el.querySelector('[data-act=use-draft]')?.addEventListener('click', () => { if (composer) { composer.body.value = r.reply; composer.body.focus(); } });
    } catch (e) { fail(e); } finally { b.disabled = false; b.textContent = '✦ Draft reply & fix'; }
  });

  on(el, 'click', '[data-act=edit-desc]', async () => {
    const r = await modal({ title: 'Edit ticket', body: html`<div class="field"><label>Title</label><input name="title" value="${t.title}"></div><div class="field"><label>Description</label><textarea name="description" rows="8">${t.description}</textarea></div>` });
    if (r) update(r, 'Saved');
  });
  on(el, 'click', '[data-act=edit-plan]', async () => {
    const r = await modal({ title: 'Edit change plan', wide: true, body: html`
      <div class="grid g2"><div class="field"><label>Change type</label><select name="change_type">${options([['normal', 'Normal'], ['standard', 'Standard'], ['emergency', 'Emergency']], det.change_type)}</select></div>
      <div class="field"><label class="check" style="margin-top:26px"><input type="checkbox" name="outage_expected" ${det.outage_expected ? raw('checked') : ''}> Outage expected</label></div>
      <div class="field"><label>Planned start</label><input type="datetime-local" name="planned_start" value="${toLocalInput(det.planned_start)}"></div>
      <div class="field"><label>Planned end</label><input type="datetime-local" name="planned_end" value="${toLocalInput(det.planned_end)}"></div></div>
      <div class="field"><label>Implementation plan</label><textarea name="implementation_plan" rows="3">${det.implementation_plan || ''}</textarea></div>
      <div class="field"><label>Backout plan</label><textarea name="backout_plan" rows="2">${det.backout_plan || ''}</textarea></div>
      <div class="field"><label>Test plan</label><textarea name="test_plan" rows="2">${det.test_plan || ''}</textarea></div>` });
    if (r) update({ details: r }, 'Plan updated');
  });
  on(el, 'click', '[data-act=edit-rca]', async () => {
    const r = await modal({ title: 'Root cause analysis', wide: true, body: html`<div class="field"><label>Root cause</label><textarea name="root_cause" rows="4">${det.root_cause || ''}</textarea></div><div class="field"><label>Workaround</label><textarea name="workaround" rows="3">${det.workaround || ''}</textarea></div>` });
    if (r) update({ details: r }, 'Saved');
  });
  on(el, 'click', '[data-act=new-problem]', async (a, e) => {
    e.preventDefault();
    try {
      const p = await post('/api/tickets', { type: 'problem', title: t.title, description: `Created from ${t.number}.\n\n${t.description}`, ci_id: t.ci_id, category: t.category, impact: t.impact, urgency: t.urgency });
      await patch(`/api/tickets/${t.id}`, { problem_id: p.id });
      state.cache.problems = undefined; toast(`${p.number} created and linked`); location.hash = `#/tickets/${p.id}`;
    } catch (err) { fail(err); }
  });
  on(el, 'click', '[data-act=kb]', async (b) => {
    b.disabled = true;
    try { const a = await post(`/api/tickets/${t.id}/kb`); toast(`Draft ${a.number} created`); location.hash = `#/kb/${a.id}/edit`; } catch (e) { fail(e); b.disabled = false; }
  });
}

export async function approvalsView(el) {
  const list = await get('/api/approvals');
  el.innerHTML = String(html`<div class="page-head"><div><h1>Approvals</h1><p>Changes and requests waiting for your decision.</p></div></div>
    ${list.length ? html`<div class="table-wrap"><table><thead><tr><th>Ticket</th><th>Title</th><th>Type</th><th>Requested by</th><th>Waiting</th><th></th></tr></thead><tbody>
      ${list.map((a) => html`<tr><td class="nowrap"><a href="#/tickets/${a.ticket_id}"><strong>${a.number}</strong></a></td><td>${a.title}${a.type === 'change' ? html`<div class="small muted">${label(a.details.change_type)} change · <span class="risk-${a.details.risk}">${a.details.risk} risk</span> · ${dt(a.details.planned_start)}</div>` : ''}</td>
        <td>${TYPE_LABEL[a.type]}</td><td>${a.requester_name || '—'}</td><td class="small muted">${timeAgo(a.created_at)}</td>
        <td class="nowrap"><div class="btn-row"><button class="btn sm danger" data-decide="rejected" data-id="${a.id}">Reject</button><button class="btn sm good" data-decide="approved" data-id="${a.id}">Approve</button></div></td></tr>`)}
    </tbody></table></div>` : html`<div class="card empty"><h2>Nothing waiting on you</h2><p class="muted">New approval requests will show up here and in your notifications.</p></div>`}`);
  on(el, 'click', '[data-decide]', async (b) => {
    const decision = b.dataset.decide;
    const r = await modal({ title: decision === 'approved' ? 'Approve' : 'Reject', submit: decision === 'approved' ? 'Approve' : 'Reject', danger: decision === 'rejected',
      body: html`<div class="field"><label>Comment${decision === 'rejected' ? ' (required)' : ' (optional)'}</label><textarea name="comment" rows="3"></textarea></div>` });
    if (!r) return;
    try { await post(`/api/approvals/${b.dataset.id}`, { decision, comment: r.comment }); toast('Decision recorded'); refreshBadges(); approvalsView(fresh(el)); } catch (e) { fail(e); }
  });
}

function csatBlock(t, staff) {
  const rateable = ['incident', 'request'].includes(t.type) && t.resolved_at && !['canceled', 'rejected'].includes(t.status);
  if (!rateable) return '';
  const stars = (n) => html`<span style="color:#c98500">${'★'.repeat(n)}</span><span style="color:var(--line-2)">${'★'.repeat(5 - n)}</span>`;
  if (t.csat_score) {
    return html`<div class="card" style="margin-bottom:14px;display:flex;gap:12px;align-items:center;flex-wrap:wrap"><strong>Customer satisfaction</strong> ${stars(t.csat_score)} <span class="muted">${t.csat_score}/5</span>${t.csat_comment ? html`<span class="muted">— “${t.csat_comment}”</span>` : ''}</div>`;
  }
  if (staff) return '';
  return html`<form class="ai-box" id="csat" style="margin-bottom:14px"><div class="ai-label">How did we do?</div>
    <div style="margin:6px 0 2px" role="radiogroup" aria-label="Rating">${[1, 2, 3, 4, 5].map((n) => html`<button type="button" class="star" data-star="${n}" aria-label="${n} star${n > 1 ? 's' : ''}">★</button>`)}</div>
    <div class="csat-more hidden"><textarea name="comment" rows="2" placeholder="Anything we could do better? (optional)" style="margin:6px 0"></textarea><button class="btn primary sm" type="submit">Send feedback</button></div></form>`;
}
