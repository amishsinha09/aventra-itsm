import { fresh, html, raw, get, post, patch, on, toast, fail, formData, md, label, timeAgo, dateOnly, options, statusBadge } from './lib.js';
import { state, isStaff, isAdmin } from './app.js';

const KB_STATUS = { draft: 'st-wait', published: 'st-done', retired: 'st-closed' };

export async function kbListView(el) {
  const staff = isStaff();
  const f = { q: state.query.get('q') || '', status: state.query.get('status') || '' };
  el.innerHTML = String(html`<div class="page-head"><div><h1>Knowledge base</h1><p>${staff ? 'Fixes, how-tos and known errors. Drafts can be generated from resolved tickets.' : 'Answers to common questions — often faster than a ticket.'}</p></div>
    ${staff ? html`<a class="btn primary" href="#/kb/new">New article</a>` : ''}</div>
    <form class="filters" id="filters"><input type="search" name="q" placeholder="Search articles…" value="${f.q}" style="min-width:320px">
    ${staff ? html`<select name="status">${options(['published', 'draft', 'retired'], f.status, { blank: 'Any status' })}</select>` : ''}</form>
    <div id="results"></div>`);
  const load = async () => {
    const rows = await get(`/api/kb?${new URLSearchParams(Object.entries(f).filter(([, v]) => v))}`);
    el.querySelector('#results').innerHTML = String(rows.length ? html`<div class="grid g2">${rows.map((a) => html`<a class="tile" href="#/kb/${a.id}">
      <div class="small faint">${a.number} · ${a.category || 'General'} ${staff ? html`· <span class="badge ${KB_STATUS[a.status]}">${label(a.status)}</span> ${a.audience === 'internal' ? html`<span class="tag">Internal</span>` : ''}` : ''}</div>
      <div class="t" style="margin-top:4px">${a.title}</div><div class="d">${a.excerpt}…</div>
      <div class="small faint" style="margin-top:8px">👁 ${a.views} · 👍 ${a.helpful} · updated ${timeAgo(a.updated_at)}</div></a>`)}</div>`
      : html`<div class="card empty"><h2>No articles found</h2>${!staff ? html`<p class="muted">Can't find an answer? <a href="#/new/incident">Report an issue</a>.</p>` : ''}</div>`);
  };
  const form = el.querySelector('#filters'); let t;
  form.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { Object.assign(f, Object.fromEntries(new FormData(form))); load().catch(fail); }, 250); });
  form.addEventListener('submit', (e) => e.preventDefault());
  await load();
}

export async function kbArticleView(el, id) {
  const a = await get(`/api/kb/${id}`);
  const staff = isStaff();
  el.innerHTML = String(html`<div class="article">
    <div class="meta small muted" style="margin-bottom:6px"><a href="#/kb">Knowledge</a> / ${a.number} · ${a.category || 'General'} ${staff ? html`<span class="badge ${KB_STATUS[a.status]}">${label(a.status)}</span> ${a.audience === 'internal' ? html`<span class="tag">Internal only</span>` : ''}` : ''}</div>
    <div class="page-head"><h1>${a.title}</h1>${staff ? html`<div class="btn-row">${a.status === 'draft' ? html`<button class="btn good" data-act="publish">Publish</button>` : ''}<a class="btn" href="#/kb/${a.id}/edit">Edit</a></div>` : ''}</div>
    <div class="card article-body">${md(a.body)}</div>
    <div class="card" style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap"><span class="muted">Was this helpful?</span>
      <div class="btn-row" id="fb"><button class="btn sm" data-helpful="true">👍 Yes</button><button class="btn sm" data-helpful="false">👎 No</button></div></div>
    <p class="small faint">${a.author_name ? `Written by ${a.author_name} · ` : ''}updated ${dateOnly(a.updated_at)} · ${a.views} views${a.source_ticket_id && staff ? html` · <a href="#/tickets/${a.source_ticket_id}">source ticket</a>` : ''}</p>
    ${!staff ? html`<p>Still stuck? <a class="btn primary sm" href="#/new/incident">Report an issue</a></p>` : ''}</div>`);
  on(el, 'click', '[data-helpful]', async (b) => {
    try {
      await post(`/api/kb/${a.id}/feedback`, { helpful: b.dataset.helpful === 'true' });
      el.querySelector('#fb').innerHTML = String(b.dataset.helpful === 'true' ? html`<span class="muted">Thanks! Glad it helped.</span>` : html`<span class="muted">Thanks — sorry about that.</span> <a class="btn sm" href="#/new/incident">Get help</a>`);
    } catch (e) { fail(e); }
  });
  on(el, 'click', '[data-act=publish]', async () => { try { await patch(`/api/kb/${a.id}`, { status: 'published' }); toast('Published'); kbArticleView(fresh(el), id); } catch (e) { fail(e); } });
}

export async function kbEditView(el, id) {
  const a = id ? await get(`/api/kb/${id}`) : { title: '', body: '## Symptoms\n\n## Cause\n\n## Resolution\n1. \n', category: '', status: 'draft', audience: 'public' };
  el.innerHTML = String(html`<div class="page-head"><h1>${id ? `Edit ${a.number}` : 'New article'}</h1></div>
    <form class="split" id="f"><div class="card">
      <div class="field"><label>Title</label><input name="title" value="${a.title}" required></div>
      <div class="field"><label>Body (Markdown: ## headings, **bold**, - lists, 1. steps, \`code\`)</label><textarea name="body" rows="18" style="font-family:ui-monospace,monospace;font-size:13px">${a.body}</textarea></div>
      <div class="btn-row"><button class="btn primary" type="submit">Save</button><a class="btn" href="${id ? `#/kb/${id}` : '#/kb'}">Cancel</a></div></div>
      <div class="card side-panel"><div class="field"><label>Category</label><select name="category">${options(state.meta.categories.map((c) => [c, c]), a.category, { blank: 'General' })}</select></div>
        <div class="field"><label>Status</label><select name="status">${options(['draft', 'published', 'retired'], a.status)}</select></div>
        <div class="field"><label>Audience</label><select name="audience">${options([['public', 'Everyone (portal)'], ['internal', 'Agents only']], a.audience)}</select></div>
        <h3 style="margin:14px 0 6px">Preview</h3><div class="article-body small" id="preview" style="max-height:420px;overflow:auto"></div></div></form>`);
  const f = el.querySelector('#f');
  const prev = () => { el.querySelector('#preview').innerHTML = String(md(f.body.value)); };
  prev(); f.body.addEventListener('input', prev);
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(f); if (!d.category) d.category = null;
    try { const r = id ? await patch(`/api/kb/${id}`, d) : await post('/api/kb', d); toast('Saved'); location.hash = `#/kb/${r.id}`; } catch (err) { fail(err); }
  });
}

// ---------------------------------------------------------------- Catalog
const CAT_ICON = { Hardware: '💻', Software: '🧩', Access: '🔑', Email: '✉', Network: '🌐', General: '📦' };

export async function catalogView(el) {
  const items = await get(`/api/catalog${isAdmin() ? '?all=true' : ''}`);
  const cats = [...new Set(items.map((i) => i.category))];
  el.innerHTML = String(html`<div class="page-head"><div><h1>Service catalog</h1><p>Order hardware, software and access. Items needing approval are routed automatically.</p></div>
    ${isAdmin() ? html`<a class="btn" href="#/admin/catalog">Manage catalog</a>` : ''}</div>
    ${cats.map((c) => html`<h3 style="margin:18px 0 10px">${c}</h3><div class="grid g3">${items.filter((i) => i.category === c).map((i) => html`<a class="tile" href="#/catalog/${i.id}" style="${i.active ? '' : 'opacity:.55'}">
      <div class="ico">${CAT_ICON[i.category] || '📦'}</div><div class="t">${i.name}${i.active ? '' : ' (inactive)'}</div><div class="d">${i.description || ''}</div>
      ${i.approval_required ? html`<div class="small faint" style="margin-top:8px">✓ Requires approval</div>` : ''}</a>`)}</div>`)}
    ${!items.length ? html`<div class="card empty">No catalog items yet.</div>` : ''}`);
}

export async function catalogOrderView(el, id) {
  const item = await get(`/api/catalog/${id}`);
  const field = (f) => {
    const req = f.required ? raw('required') : '';
    const lab = html`<label>${f.label || label(f.name)}${f.required ? ' *' : ''}</label>`;
    if (f.type === 'textarea') return html`<div class="field">${lab}<textarea name="v_${f.name}" rows="3" ${req}></textarea></div>`;
    if (f.type === 'select') return html`<div class="field">${lab}<select name="v_${f.name}" ${req}>${options(f.options.map((o) => [o, o]), '', { blank: 'Choose…' })}</select></div>`;
    if (f.type === 'checkbox') return html`<div class="field"><label class="check"><input type="checkbox" name="v_${f.name}"> ${f.label || label(f.name)}</label></div>`;
    return html`<div class="field">${lab}<input type="${f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}" name="v_${f.name}" ${req}></div>`;
  };
  el.innerHTML = String(html`<div class="article"><div class="small muted"><a href="#/catalog">Service catalog</a> / ${item.category}</div>
    <div class="page-head"><div><h1>${CAT_ICON[item.category] || '📦'} ${item.name}</h1><p>${item.description || ''}</p></div></div>
    <form class="card" id="f" novalidate>${(item.fields || []).map(field)}
      <div class="field"><label>Anything else we should know?</label><textarea name="description" rows="3"></textarea></div>
      ${item.approval_required ? html`<p class="small muted">ℹ This request needs approval before it's fulfilled. You'll be notified at each step.</p>` : ''}
      <div class="btn-row"><button class="btn primary" type="submit">Submit request</button><a class="btn" href="#/catalog">Cancel</a></div></form></div>`);
  const f = el.querySelector('#f');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(f); const variables = {};
    for (const [k, v] of Object.entries(d)) if (k.startsWith('v_')) variables[k.slice(2)] = v;
    try {
      const t = await post('/api/tickets', { type: 'request', catalog_item_id: item.id, description: d.description, details: { variables } });
      toast(`${t.number} submitted`); location.hash = `#/tickets/${t.id}`;
    } catch (err) { fail(err); }
  });
}

// ---------------------------------------------------------------- Portal home (requesters)
export async function portalHomeView(el) {
  const [dash, kb] = await Promise.all([get('/api/dashboard'), get('/api/kb')]);
  const open = dash.mine?.filter((t) => !['resolved', 'closed', 'canceled', 'fulfilled', 'rejected'].includes(t.status)) || [];
  el.innerHTML = String(html`<div class="portal-hero"><h1>Hi ${state.me.user.name.split(' ')[0]}, how can we help?</h1>
      <p style="opacity:.85;margin:6px 0 0">Search for an answer, report a problem, or request something new.</p>
      <form id="s"><input type="search" name="q" placeholder="e.g. reset my password, VPN not connecting…" aria-label="Search help articles"></form></div>
    <div class="grid g3">
      <a class="tile" href="#/new/incident"><div class="ico">🛠</div><div class="t">Report an issue</div><div class="d">Something is broken or not working as expected.</div></a>
      <a class="tile" href="#/catalog"><div class="ico">🛒</div><div class="t">Request something</div><div class="d">Hardware, software, access and onboarding.</div></a>
      <a class="tile" href="#/kb"><div class="ico">📖</div><div class="t">Browse knowledge</div><div class="d">Guides and fixes for common problems.</div></a></div>
    <div class="grid g2" style="margin-top:18px">
      <div class="card"><div class="card-head"><h2>My open tickets</h2><a class="small" href="#/my">View all</a></div>
        ${open.length ? html`<div class="list-links">${open.map((t) => html`<a href="#/tickets/${t.id}"><strong>${t.number}</strong> ${t.title} ${statusBadge(t.status)}<br><span class="small faint">updated ${timeAgo(t.updated_at)}</span></a>`)}</div>` : html`<div class="small faint">You have no open tickets.</div>`}</div>
      <div class="card"><div class="card-head"><h2>Popular articles</h2></div>
        <div class="list-links">${kb.sort((a, b) => b.views - a.views).slice(0, 5).map((a) => html`<a href="#/kb/${a.id}">📖 ${a.title}</a>`)}</div></div></div>`);
  el.querySelector('#s').addEventListener('submit', (e) => { e.preventDefault(); location.hash = `#/kb?q=${encodeURIComponent(e.target.q.value)}`; });
}
