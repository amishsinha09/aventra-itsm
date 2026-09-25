import { fresh, html, raw, get, post, patch, del, on, toast, fail, modal, label, timeAgo, dt, options, priorityBadge, statusBadge } from './lib.js';
import { state, lookup, isAdmin } from './app.js';

const CLASSES = ['server', 'workstation', 'laptop', 'network', 'application', 'database', 'service', 'cloud', 'storage', 'mobile', 'printer'];
const STATUSES = ['operational', 'degraded', 'down', 'maintenance', 'retired'];
const ICON = { server: '🖥', workstation: '💻', laptop: '💻', network: '🔀', application: '🧩', database: '🗄', service: '☁', cloud: '☁', storage: '💾', mobile: '📱', printer: '🖨' };
const CI_STATUS = { operational: 'st-done', degraded: 'st-wait', down: 'st-bad', maintenance: 'st-open', retired: 'st-closed' };
export const ciStatus = (s) => html`<span class="badge ${CI_STATUS[s]}">${label(s)}</span>`;
const CRIT = { 1: 'Mission critical', 2: 'High', 3: 'Medium', 4: 'Low' };

async function ciForm(ci = {}) {
  const [companies, groups, users] = await Promise.all([lookup('companies'), lookup('groups'), lookup('users')]);
  return html`<div class="grid g2">
    <div class="field" style="grid-column:1/-1"><label>Name / hostname</label><input name="name" value="${ci.name || ''}" required></div>
    <div class="field"><label>Class</label><select name="ci_class">${options(CLASSES, ci.ci_class || 'server')}</select></div>
    <div class="field"><label>Status</label><select name="status">${options(STATUSES, ci.status || 'operational')}</select></div>
    <div class="field"><label>Criticality</label><select name="criticality" data-type="int">${options(Object.entries(CRIT).map(([k, v]) => [k, `${k} – ${v}`]), ci.criticality || 3)}</select></div>
    <div class="field"><label>Environment</label><select name="environment">${options(['production', 'staging', 'development', 'test', 'dr'], ci.environment || 'production')}</select></div>
    <div class="field"><label>Company</label><select name="company_id" data-type="int">${options(companies, ci.company_id, { blank: '— none —' })}</select></div>
    <div class="field"><label>Support group</label><select name="support_group_id" data-type="int">${options(groups, ci.support_group_id, { blank: '— none —' })}</select></div>
    <div class="field"><label>IP address</label><input name="ip_address" value="${ci.ip_address || ''}"></div>
    <div class="field"><label>Operating system</label><input name="os" value="${ci.os || ''}"></div>
    <div class="field"><label>Serial number</label><input name="serial_number" value="${ci.serial_number || ''}"></div>
    <div class="field"><label>Owner</label><select name="owner_id" data-type="int">${options(users, ci.owner_id, { blank: '— none —' })}</select></div></div>`;
}
const clean = (d) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v === '' ? null : v]));

export async function cmdbListView(el) {
  const f = { q: state.query.get('q') || '', class: state.query.get('class') || '', status: state.query.get('status') || '', company: state.query.get('company') || '' };
  const companies = await lookup('companies');
  el.innerHTML = String(html`<div class="page-head"><div><h1>Configuration management</h1><p>Every device, application and service you support — with dependencies for impact analysis. Aventra agents keep it up to date automatically.</p></div>
    <button class="btn primary" data-act="new">Add CI</button></div>
    <form class="filters" id="filters"><input type="search" name="q" placeholder="Name, IP or serial…" value="${f.q}">
      <select name="class">${options(CLASSES, f.class, { blank: 'All classes' })}</select>
      <select name="status">${options([...STATUSES.map((s) => [s, label(s)]), ['all', 'Include retired']], f.status, { blank: 'Active' })}</select>
      <select name="company">${options(companies, f.company, { blank: 'All companies' })}</select></form>
    <div id="results"></div>`);
  const load = async () => {
    const p = new URLSearchParams(Object.entries(f).filter(([, v]) => v));
    const rows = await get(`/api/cis?${p}`);
    el.querySelector('#results').innerHTML = String(rows.length ? html`<div class="table-wrap"><table><thead><tr><th>Name</th><th>Class</th><th>Status</th><th>Criticality</th><th>Company</th><th>IP / OS</th><th>Open tickets</th><th>Last seen</th></tr></thead><tbody>
      ${rows.map((c) => html`<tr class="clickable" data-href="#/cmdb/${c.id}"><td><a href="#/cmdb/${c.id}"><strong>${ICON[c.ci_class] || '▣'} ${c.name}</strong></a>${c.source === 'aventra' ? html` <span class="tag auto">⚡ discovered</span>` : ''}</td>
        <td>${label(c.ci_class)}</td><td>${ciStatus(c.status)}</td><td>${c.criticality} – ${CRIT[c.criticality]}</td><td class="small">${c.company_name || ''}</td>
        <td class="small">${c.ip_address || ''}<div class="faint">${c.os || ''}</div></td><td class="num">${c.open_tickets || html`<span class="faint">0</span>`}</td><td class="small muted">${c.last_seen_at ? timeAgo(c.last_seen_at) : '—'}</td></tr>`)}
      </tbody></table></div>` : html`<div class="card empty"><h2>No configuration items yet</h2><p class="muted">Add CIs manually, or connect Aventra agents to discover devices automatically.</p></div>`);
  };
  const form = el.querySelector('#filters'); let t;
  form.addEventListener('change', () => { Object.assign(f, Object.fromEntries(new FormData(form))); load().catch(fail); });
  form.addEventListener('input', (e) => { if (e.target.name === 'q') { clearTimeout(t); t = setTimeout(() => { f.q = e.target.value; load().catch(fail); }, 300); } });
  form.addEventListener('submit', (e) => e.preventDefault());
  on(el, 'click', 'tr[data-href]', (tr, e) => { if (!e.target.closest('a')) location.hash = tr.dataset.href; });
  on(el, 'click', '[data-act=new]', async () => {
    const ci = await modal({ title: 'Add configuration item', wide: true, body: await ciForm(), submit: 'Create', onSubmit: (d) => post('/api/cis', clean(d)) });
    if (ci) { state.cache.cis = undefined; toast(`${ci.name} added`); location.hash = `#/cmdb/${ci.id}`; }
  });
  await load();
}

export async function cmdbDetailView(el, id) {
  const { ci, relationships, impacted, tickets } = await get(`/api/cis/${id}`);
  const deps = relationships.filter((r) => r.parent_id === ci.id);
  const dependents = relationships.filter((r) => r.child_id === ci.id);
  const relRow = (r, other) => html`<div class="approval"><span><span class="faint small">${label(r.rel_type)}</span> <a href="#/cmdb/${r[`${other}_id`]}">${r[`${other}_name`]}</a> ${ciStatus(r[`${other}_status`])}</span><button class="btn sm ghost" data-unrel="${r.id}" title="Remove relationship">✕</button></div>`;
  el.innerHTML = String(html`<div class="ticket-head"><div><div class="meta"><a href="#/cmdb">CMDB</a> / ${label(ci.ci_class)} ${ciStatus(ci.status)} ${ci.source === 'aventra' ? html`<span class="tag auto">⚡ Aventra managed</span>` : ''}</div>
      <h1>${ICON[ci.ci_class] || ''} ${ci.name}</h1><div class="small muted">${ci.company_name || 'No company'} · ${label(ci.environment)} · criticality ${ci.criticality} (${CRIT[ci.criticality]})</div></div>
    <div class="btn-row"><a class="btn" href="#/new/incident?ci=${ci.id}">Raise incident</a><a class="btn" href="#/new/change?ci=${ci.id}">Plan change</a><button class="btn" data-act="edit">Edit</button>${isAdmin() && ci.status !== 'retired' ? html`<button class="btn danger" data-act="retire">Retire</button>` : ''}</div></div>
  <div class="split"><div class="stack">
    <div class="card"><div class="card-head"><h2>Impact analysis</h2><span class="small faint">What breaks if ${ci.name} goes down</span></div>
      ${impacted.length ? html`<div class="list-links">${impacted.map((c) => html`<a href="#/cmdb/${c.id}">${'↳ '.repeat(c.depth)}${ICON[c.ci_class] || ''} <strong>${c.name}</strong> <span class="small faint">${label(c.ci_class)} · criticality ${c.criticality}</span> ${ciStatus(c.status)}</a>`)}</div>`
    : html`<div class="small faint">Nothing depends on this CI.</div>`}</div>
    <div class="grid g2">
      <div class="card"><div class="card-head"><h2>Depends on</h2><button class="btn sm" data-act="rel">+ Add</button></div>${deps.length ? deps.map((r) => relRow(r, 'child')) : html`<div class="small faint">No dependencies recorded.</div>`}</div>
      <div class="card"><div class="card-head"><h2>Used by</h2></div>${dependents.length ? dependents.map((r) => relRow(r, 'parent')) : html`<div class="small faint">Nothing uses this CI.</div>`}</div>
    </div>
    <div class="card"><div class="card-head"><h2>Tickets</h2><a class="small" href="#/list/incident?ci=${ci.id}&open=">All</a></div>
      ${tickets.length ? html`<div class="list-links">${tickets.map((t) => html`<a href="#/tickets/${t.id}"><strong>${t.number}</strong> ${t.title} ${priorityBadge(t.priority)} ${statusBadge(t.status)} <span class="small faint">${timeAgo(t.created_at)}</span></a>`)}</div>` : html`<div class="small faint">No tickets reference this CI.</div>`}</div>
  </div>
  <aside class="card"><h2 style="margin-bottom:10px">Attributes</h2><div class="kv small">
    <div>IP address</div><div>${ci.ip_address || '—'}</div><div>OS</div><div>${ci.os || '—'}</div><div>Serial</div><div>${ci.serial_number || '—'}</div>
    <div>Support group</div><div>${ci.support_group_name || '—'}</div><div>Owner</div><div>${ci.owner_name || '—'}</div><div>Source</div><div>${label(ci.source)}</div>
    <div>Last seen</div><div>${ci.last_seen_at ? dt(ci.last_seen_at) : '—'}</div><div>Updated</div><div>${dt(ci.updated_at)}</div>
    ${Object.entries(ci.attributes || {}).map(([k, v]) => html`<div>${label(k)}</div><div>${typeof v === 'object' ? JSON.stringify(v) : String(v)}</div>`)}</div></aside></div>`);

  const reload = () => cmdbDetailView(fresh(el), id);
  on(el, 'click', '[data-act=edit]', async () => {
    const r = await modal({ title: `Edit ${ci.name}`, wide: true, body: await ciForm(ci), onSubmit: (d) => patch(`/api/cis/${ci.id}`, clean(d)) });
    if (r) { state.cache.cis = undefined; toast('Saved'); reload(); }
  });
  on(el, 'click', '[data-act=retire]', async () => {
    if (!(await modal({ title: `Retire ${ci.name}?`, body: html`<p>It stays in history but disappears from active lists.</p>`, submit: 'Retire', danger: true }))) return;
    try { await del(`/api/cis/${ci.id}`); state.cache.cis = undefined; toast('Retired'); reload(); } catch (e) { fail(e); }
  });
  on(el, 'click', '[data-act=rel]', async () => {
    const all = (await lookup('cis')).filter((c) => c.id !== ci.id);
    const r = await modal({ title: `${ci.name} depends on…`, submit: 'Add', body: html`<div class="field"><label>Configuration item</label><select name="child_id" data-type="int">${options(all.map((c) => [c.id, `${c.name} (${c.ci_class})`]))}</select></div>
      <div class="field"><label>Relationship</label><select name="rel_type">${options([['depends_on', 'Depends on'], ['runs_on', 'Runs on'], ['connects_to', 'Connects to'], ['hosts', 'Hosts'], ['backs_up', 'Backs up']], 'depends_on')}</select></div>`,
    onSubmit: (d) => post(`/api/cis/${ci.id}/relationships`, d) });
    if (r) reload();
  });
  on(el, 'click', '[data-unrel]', async (b) => { try { await del(`/api/ci-relationships/${b.dataset.unrel}`); reload(); } catch (e) { fail(e); } });
}
