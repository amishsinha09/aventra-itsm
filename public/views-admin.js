import { fresh, html, raw, get, post, patch, put, del, on, toast, fail, modal, label, timeAgo, dt, options, esc } from './lib.js';
import { state, lookup } from './app.js';

const TABS = [['users', 'Users'], ['groups', 'Groups'], ['companies', 'Companies'], ['sla', 'SLA policies'], ['catalog', 'Catalog'], ['integrations', 'Integrations'], ['workspace', 'Workspace'], ['audit', 'Audit log']];

export async function adminView(el, tab = 'users') {
  if (!TABS.some(([k]) => k === tab)) tab = 'users';
  el.innerHTML = String(html`<div class="page-head"><div><h1>Settings</h1><p>Configure your workspace, people, SLAs and integrations.</p></div></div>
    <nav class="tabs">${TABS.map(([k, t]) => html`<a href="#/admin/${k}" class="${k === tab ? 'on' : ''}">${t}</a>`)}</nav><div id="tab"></div>`);
  const box = el.querySelector('#tab');
  const reload = () => { state.cache = {}; adminView(fresh(el), tab); };
  await ({ users, groups, companies, sla, catalog, integrations, workspace, audit })[tab](box, reload);
}

async function users(box, reload) {
  const [list, companies, groups] = await Promise.all([get('/api/users'), lookup('companies'), lookup('groups')]);
  box.innerHTML = String(html`<div class="card-head"><span class="muted">${list.length} users · agents work tickets, requesters use the portal.</span><button class="btn primary" data-act="add">Add user</button></div>
    <div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Company</th><th>Last sign-in</th><th>Status</th><th></th></tr></thead><tbody>
    ${list.map((u) => html`<tr><td><strong>${u.name}</strong></td><td>${u.email}</td><td>${label(u.role)}</td><td>${u.company_name || '—'}</td><td class="small muted">${u.last_login_at ? timeAgo(u.last_login_at) : 'Never'}</td>
      <td>${u.active ? html`<span class="badge st-done">Active</span>` : html`<span class="badge st-closed">Disabled</span>`}</td><td><button class="btn sm" data-edit="${u.id}">Edit</button></td></tr>`)}</tbody></table></div>`);
  const form = (u = {}) => html`<div class="field"><label>Name</label><input name="name" value="${u.name || ''}" required></div>
    ${u.id ? '' : html`<div class="field"><label>Email</label><input name="email" type="email" required></div>`}
    <div class="grid g2"><div class="field"><label>Role</label><select name="role">${options([['agent', 'Agent'], ['admin', 'Admin'], ['requester', 'Requester (portal only)']], u.role || 'agent')}</select></div>
    <div class="field"><label>Company</label><select name="company_id" data-type="int">${options(companies, u.company_id, { blank: '— none —' })}</select></div></div>
    ${u.id ? html`<label class="check field"><input type="checkbox" name="active" ${u.active ? raw('checked') : ''}> Active</label>` : html`<div class="field"><label>Groups</label>${groups.map((g) => html`<label class="check"><input type="checkbox" name="g_${g.id}"> ${g.name}</label>`)}</div>`}
    <div class="field"><label>${u.id ? 'Reset password (optional)' : 'Password'}</label><input name="password" type="password" autocomplete="new-password"><div class="hint">${u.id ? 'Leave blank to keep the current password.' : 'Leave blank for users who only email in (they can be given one later).'}</div></div>`;
  on(box, 'click', '[data-act=add]', async () => {
    const r = await modal({ title: 'Add user', body: form(), submit: 'Create', onSubmit: (d) => {
      const group_ids = Object.keys(d).filter((k) => k.startsWith('g_') && d[k]).map((k) => +k.slice(2));
      const body = { name: d.name, email: d.email, role: d.role, company_id: d.company_id, group_ids };
      if (d.password) body.password = d.password;
      return post('/api/users', body);
    } });
    if (r) { toast(`${r.name} added`); reload(); }
  });
  on(box, 'click', '[data-edit]', async (b) => {
    const u = list.find((x) => x.id === +b.dataset.edit);
    const r = await modal({ title: `Edit ${u.name}`, body: form(u), onSubmit: (d) => { const body = { name: d.name, role: d.role, company_id: d.company_id, active: d.active }; if (d.password) body.password = d.password; return patch(`/api/users/${u.id}`, body); } });
    if (r) { toast('Saved'); reload(); }
  });
}

async function groups(box, reload) {
  const [list, agents] = await Promise.all([get('/api/groups'), lookup('users')]);
  box.innerHTML = String(html`<div class="card-head"><span class="muted">Groups receive tickets for their categories. Mark one as the Change Advisory Board to approve changes.</span><button class="btn primary" data-act="add">Add group</button></div>
    <div class="grid g2">${list.map((g) => html`<div class="card"><div class="card-head"><h2>${g.name} ${g.is_cab ? html`<span class="tag">CAB</span>` : ''}</h2><button class="btn sm" data-edit="${g.id}">Edit</button></div>
      <div class="small muted">${g.description || ''}</div>
      <div class="small" style="margin-top:8px"><strong>Auto-routes:</strong> ${g.categories.length ? g.categories.join(', ') : html`<span class="faint">none</span>`}</div>
      <div class="small"><strong>Members:</strong> ${g.members.length ? g.members.map((m) => m.name).join(', ') : html`<span class="faint">none</span>`}</div></div>`)}</div>`);
  const form = (g = { categories: [], members: [] }) => html`<div class="field"><label>Name</label><input name="name" value="${g.name || ''}" required></div>
    <div class="field"><label>Description</label><input name="description" value="${g.description || ''}"></div>
    <label class="check field"><input type="checkbox" name="is_cab" ${g.is_cab ? raw('checked') : ''}> Change Advisory Board (approves changes)</label>
    <div class="grid g2"><div class="field"><label>Auto-route categories</label>${state.meta.categories.map((c) => html`<label class="check"><input type="checkbox" name="c_${c}" ${g.categories.includes(c) ? raw('checked') : ''}> ${c}</label>`)}</div>
    <div class="field"><label>Members</label>${agents.map((u) => html`<label class="check"><input type="checkbox" name="m_${u.id}" ${g.members.some((m) => m.id === u.id) ? raw('checked') : ''}> ${u.name}</label>`)}</div></div>`;
  const body = (d) => ({ name: d.name, description: d.description, is_cab: d.is_cab,
    categories: Object.keys(d).filter((k) => k.startsWith('c_') && d[k]).map((k) => k.slice(2)),
    member_ids: Object.keys(d).filter((k) => k.startsWith('m_') && d[k]).map((k) => +k.slice(2)) });
  on(box, 'click', '[data-act=add]', async () => { if (await modal({ title: 'Add group', wide: true, body: form(), submit: 'Create', onSubmit: (d) => post('/api/groups', body(d)) })) reload(); });
  on(box, 'click', '[data-edit]', async (b) => {
    const g = list.find((x) => x.id === +b.dataset.edit);
    if (await modal({ title: `Edit ${g.name}`, wide: true, body: form(g), onSubmit: (d) => patch(`/api/groups/${g.id}`, body(d)) })) { toast('Saved'); reload(); }
  });
}

async function companies(box, reload) {
  const list = await get('/api/companies');
  box.innerHTML = String(html`<div class="card-head"><span class="muted">Customers you support. Emails from a company's domain create tickets automatically.</span><button class="btn primary" data-act="add">Add company</button></div>
    <div class="table-wrap"><table><thead><tr><th>Company</th><th>Email domain</th><th>Users</th><th>CIs</th><th>Open tickets</th><th></th></tr></thead><tbody>
    ${list.map((c) => html`<tr><td><strong>${c.name}</strong>${c.active ? '' : html` <span class="badge st-closed">Inactive</span>`}</td><td>${c.domain || '—'}</td><td class="num">${c.users}</td><td class="num">${c.cis}</td><td class="num">${c.open_tickets}</td><td><button class="btn sm" data-edit="${c.id}">Edit</button></td></tr>`)}</tbody></table></div>`);
  const form = (c = {}) => html`<div class="field"><label>Name</label><input name="name" value="${c.name || ''}" required></div><div class="field"><label>Email domain</label><input name="domain" value="${c.domain || ''}" placeholder="example.com"></div>
    ${c.id ? html`<label class="check"><input type="checkbox" name="active" ${c.active ? raw('checked') : ''}> Active</label>` : ''}`;
  on(box, 'click', '[data-act=add]', async () => { if (await modal({ title: 'Add company', body: form(), submit: 'Create', onSubmit: (d) => post('/api/companies', d) })) reload(); });
  on(box, 'click', '[data-edit]', async (b) => { const c = list.find((x) => x.id === +b.dataset.edit); if (await modal({ title: `Edit ${c.name}`, body: form(c), onSubmit: (d) => patch(`/api/companies/${c.id}`, d) })) reload(); });
}

async function sla(box) {
  const list = await get('/api/sla-policies');
  const fmt = (m) => (m % 1440 === 0 ? `${m / 1440}d` : m % 60 === 0 ? `${m / 60}h` : `${m}m`);
  box.innerHTML = String(html`<form id="sla"><div class="card-head"><span class="muted">Targets in minutes, measured 24×7 from creation. The clock pauses while a ticket is on hold or awaiting approval.</span><button class="btn primary" type="submit">Save SLAs</button></div>
    <div class="table-wrap"><table><thead><tr><th>Type</th><th>Priority</th><th>First response (min)</th><th>Resolution (min)</th><th>Summary</th></tr></thead><tbody>
    ${list.map((p) => html`<tr><td>${label(p.ticket_type)}</td><td>P${p.priority}</td>
      <td><input type="number" min="1" name="r_${p.ticket_type}_${p.priority}" value="${p.response_mins}" style="max-width:120px"></td>
      <td><input type="number" min="1" name="x_${p.ticket_type}_${p.priority}" value="${p.resolve_mins}" style="max-width:120px"></td>
      <td class="small muted">Respond in ${fmt(p.response_mins)}, resolve in ${fmt(p.resolve_mins)}</td></tr>`)}</tbody></table></div></form>`);
  box.querySelector('#sla').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const policies = list.map((p) => ({ ticket_type: p.ticket_type, priority: p.priority, response_mins: +fd.get(`r_${p.ticket_type}_${p.priority}`), resolve_mins: +fd.get(`x_${p.ticket_type}_${p.priority}`) }));
    try { await put('/api/sla-policies', { policies }); toast('SLA policies saved'); sla(fresh(box)); } catch (err) { fail(err); }
  });
}

async function catalog(box, reload) {
  const [items, groups] = await Promise.all([get('/api/catalog?all=true'), lookup('groups')]);
  box.innerHTML = String(html`<div class="card-head"><span class="muted">What users can order from the portal.</span><button class="btn primary" data-act="add">Add item</button></div>
    <div class="table-wrap"><table><thead><tr><th>Item</th><th>Category</th><th>Approval</th><th>Fulfilled by</th><th>Fields</th><th>Status</th><th></th></tr></thead><tbody>
    ${items.map((i) => html`<tr><td><strong>${i.name}</strong><div class="small faint">${i.description || ''}</div></td><td>${i.category}</td><td>${i.approval_required ? i.approver_group_name || 'Yes' : 'None'}</td><td>${i.fulfillment_group_name || '—'}</td><td class="num">${i.fields.length}</td>
      <td>${i.active ? html`<span class="badge st-done">Active</span>` : html`<span class="badge st-closed">Inactive</span>`}</td><td><button class="btn sm" data-edit="${i.id}">Edit</button></td></tr>`)}</tbody></table></div>`);
  const form = (i = { fields: [], active: true }) => html`<div class="grid g2"><div class="field"><label>Name</label><input name="name" value="${i.name || ''}" required></div>
    <div class="field"><label>Category</label><input name="category" value="${i.category || 'General'}"></div></div>
    <div class="field"><label>Description</label><input name="description" value="${i.description || ''}"></div>
    <div class="grid g2"><div class="field"><label>Fulfillment group</label><select name="fulfillment_group_id" data-type="int">${options(groups, i.fulfillment_group_id, { blank: '— none —' })}</select></div>
    <div class="field"><label>Approver group</label><select name="approver_group_id" data-type="int">${options(groups, i.approver_group_id, { blank: '— none —' })}</select></div></div>
    <label class="check"><input type="checkbox" name="approval_required" ${i.approval_required ? raw('checked') : ''}> Requires approval</label>
    <label class="check field"><input type="checkbox" name="active" ${i.active ? raw('checked') : ''}> Active</label>
    <div class="field"><label>Form fields (JSON)</label><textarea name="fields" rows="7" style="font-family:ui-monospace,monospace;font-size:12px">${JSON.stringify(i.fields, null, 2)}</textarea>
    <div class="hint">Each field: {"name": "model", "label": "Model", "type": "text|textarea|select|date|number|checkbox", "required": true, "options": [...]}</div></div>`;
  const body = (d) => { let fields; try { fields = JSON.parse(d.fields || '[]'); } catch { throw new Error('Form fields must be valid JSON'); } return { ...d, fields }; };
  on(box, 'click', '[data-act=add]', async () => { if (await modal({ title: 'Add catalog item', wide: true, body: form(), submit: 'Create', onSubmit: (d) => post('/api/catalog', body(d)) })) reload(); });
  on(box, 'click', '[data-edit]', async (b) => { const i = items.find((x) => x.id === +b.dataset.edit); if (await modal({ title: `Edit ${i.name}`, wide: true, body: form(i), onSubmit: (d) => patch(`/api/catalog/${i.id}`, body(d)) })) { toast('Saved'); reload(); } });
}

async function integrations(box, reload) {
  const keys = await get('/api/api-keys');
  const base = location.origin;
  box.innerHTML = String(html`<div class="grid g2">
    <div class="card"><div class="card-head"><h2>API keys</h2><button class="btn primary sm" data-act="add">Create key</button></div>
      <p class="small muted">Used by the Aventra agent, your email relay and scripts. Keys can only call <code>/api/integrations/*</code>.</p>
      ${keys.length ? html`<div class="list-links">${keys.map((k) => html`<div class="approval"><span><strong>${k.name}</strong> <code>${k.prefix}…</code><br><span class="small faint">${k.revoked_at ? 'Revoked' : k.last_used_at ? `Last used ${timeAgo(k.last_used_at)}` : 'Never used'}</span></span>${k.revoked_at ? '' : html`<button class="btn sm danger" data-revoke="${k.id}">Revoke</button>`}</div>`)}</div>` : html`<div class="small faint">No keys yet.</div>`}</div>
    <div class="card"><h2 style="margin-bottom:8px">Aventra self-healing agent</h2>
      <p class="small muted">Point AventraAgent at these endpoints with header <code>X-API-Key</code>. Alerts open incidents; successful fixes auto-resolve them; failed fixes escalate to the CI's support group.</p>
      <pre style="white-space:pre-wrap;background:var(--surface-2);padding:10px;border-radius:8px">POST ${base}/api/integrations/aventra/events
{"event":"alert.opened","alert_id":"a-123","hostname":"ACME-LT-0142",
 "company":"Acme Dental Group","severity":"high",
 "title":"Disk space low on C:"}

events: alert.opened | remediation.started |
        remediation.succeeded | remediation.failed | alert.cleared

POST ${base}/api/integrations/aventra/inventory
{"devices":[{"hostname":"ACME-LT-0142","os":"Windows 11",
  "ip_address":"10.0.0.8","company":"Acme Dental Group"}]}</pre>
      <h2 style="margin:14px 0 8px">Email to ticket</h2>
      <p class="small muted">Forward inbound email (Resend, Postmark, SendGrid) as JSON. Replies containing a ticket number become comments; senders from a company's domain are auto-registered.</p>
      <pre style="white-space:pre-wrap;background:var(--surface-2);padding:10px;border-radius:8px">POST ${base}/api/integrations/email/inbound
{"from":"Sara Kim &lt;sara@acmedental.example&gt;",
 "subject":"Re: [INC0001001] EHR slow","text":"Still slow"}</pre></div></div>`);
  on(box, 'click', '[data-act=add]', async () => {
    const k = await modal({ title: 'Create API key', submit: 'Create', body: html`<div class="field"><label>Name</label><input name="name" placeholder="e.g. Aventra agent – production" required></div>`, onSubmit: (d) => post('/api/api-keys', d) });
    if (!k) return;
    await modal({ title: 'Copy your key', submit: null, body: html`<p>This key won't be shown again. Store it in your agent's configuration.</p><div class="key-reveal">${k.key}</div>` });
    reload();
  });
  on(box, 'click', '[data-revoke]', async (b) => {
    if (!(await modal({ title: 'Revoke key?', body: html`<p>Anything using it will stop working immediately.</p>`, submit: 'Revoke', danger: true }))) return;
    try { await del(`/api/api-keys/${b.dataset.revoke}`); reload(); } catch (e) { fail(e); }
  });
}

async function workspace(box) {
  const t = await get('/api/tenant');
  const zones = Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : ['America/Chicago', 'America/New_York', 'America/Denver', 'America/Los_Angeles', 'UTC'];
  const common = ['America/Chicago', 'America/New_York', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'UTC'];
  box.innerHTML = String(html`<form class="card" id="ws" style="max-width:560px">
    <div class="field"><label>Workspace name</label><input name="name" value="${t.name}"></div>
    <div class="field"><label>Workspace ID (for sign-in)</label><input value="${t.slug}" disabled></div>
    <div class="field"><label>Default time zone</label><select name="timezone"><optgroup label="US & common">${options(common.map((z) => [z, z === 'America/Chicago' ? 'America/Chicago (Central — CST/CDT)' : z]), t.timezone)}</optgroup>
      <optgroup label="All">${options(zones.filter((z) => !common.includes(z)).map((z) => [z, z]), t.timezone)}</optgroup></select>
      <div class="hint">Used for dashboards, reports and every date shown. Users can override it for themselves.</div></div>
    <button class="btn primary" type="submit">Save</button></form>`);
  box.querySelector('#ws').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    try { await patch('/api/tenant', fd); toast('Workspace saved — reloading'); setTimeout(() => location.reload(), 600); } catch (err) { fail(err); }
  });
}

async function audit(box) {
  const rows = await get('/api/audit');
  box.innerHTML = String(html`<div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Entity</th><th>IP</th></tr></thead><tbody>
    ${rows.map((a) => html`<tr><td class="small nowrap">${dt(a.created_at)}</td><td>${a.user_name || html`<span class="faint">system / API</span>`}</td><td><code>${a.action}</code></td><td class="small">${a.entity || ''} ${a.entity_id || ''}</td><td class="small faint">${a.ip || ''}</td></tr>`)}</tbody></table></div>`);
}
