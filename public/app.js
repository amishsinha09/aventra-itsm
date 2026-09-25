import { html, raw, get, post, patch, on, toast, fail, initials, esc, prefs, tzAbbr, modal, options, dt } from './lib.js';
import { dashboardView, workView, reportsView } from './views-dash.js';
import { ticketListView, ticketNewView, ticketDetailView, approvalsView } from './views-tickets.js';
import { cmdbListView, cmdbDetailView } from './views-cmdb.js';
import { kbListView, kbArticleView, kbEditView, catalogView, catalogOrderView, portalHomeView } from './views-kb.js';
import { adminView } from './views-admin.js';
import { pricingView, billingBanner, upgradeCard } from './views-billing.js';
import { loginView, signupView, forgotView, resetView } from './views-auth.js';

export const state = { me: null, meta: null, cache: {}, query: new URLSearchParams() };
export const isStaff = () => ['admin', 'agent'].includes(state.me?.user.role);
export const isAdmin = () => state.me?.user.role === 'admin';
export const hasFeature = (f) => !state.me?.billing || state.me.billing.features.includes(f);
// Pages that belong to Pro — show an upgrade card instead of an error when the plan doesn't include them
const FEATURE_ROUTES = { '^/(list|new)/problem': 'problems', '^/(list|new)/change': 'changes', '^/cmdb': 'cmdb', '^/reports': 'reports' };

// Cached lookups used by forms (invalidate with state.cache = {})
export async function lookup(name) {
  const paths = { users: '/api/users?staff=true', allUsers: '/api/users', groups: '/api/groups', companies: '/api/companies', cis: '/api/cis?limit=500', problems: '/api/tickets?type=problem&open=true&limit=200' };
  if (!state.cache[name]) state.cache[name] = get(paths[name]).then((r) => (r.rows ? r.rows : r));
  try { return await state.cache[name]; } catch (e) { delete state.cache[name]; throw e; }
}

const routes = [
  [/^\/login$/, loginView, { public: true }],
  [/^\/signup$/, signupView, { public: true }],
  [/^\/forgot$/, forgotView, { public: true }],
  [/^\/pricing$/, pricingView, { public: true }],
  [/^\/reset$/, resetView, { public: true }],
  [/^\/dashboard$/, dashboardView, { staff: true }],
  [/^\/work$/, workView, { staff: true }],
  [/^\/reports$/, reportsView, { staff: true }],
  [/^\/list\/(incident|request|problem|change)$/, ticketListView, { staff: true }],
  [/^\/my$/, (el) => ticketListView(el, 'mine')],
  [/^\/new\/(incident|request|problem|change)$/, ticketNewView],
  [/^\/tickets\/(\d+)$/, ticketDetailView],
  [/^\/approvals$/, approvalsView],
  [/^\/cmdb$/, cmdbListView, { staff: true }],
  [/^\/cmdb\/(\d+)$/, cmdbDetailView, { staff: true }],
  [/^\/kb$/, kbListView],
  [/^\/kb\/new$/, (el) => kbEditView(el, null), { staff: true }],
  [/^\/kb\/(\d+)\/edit$/, kbEditView, { staff: true }],
  [/^\/kb\/(\d+)$/, kbArticleView],
  [/^\/catalog$/, catalogView],
  [/^\/catalog\/(\d+)$/, catalogOrderView],
  [/^\/home$/, portalHomeView],
  [/^\/admin(?:\/(\w+))?$/, adminView, { admin: true }],
];

const NAV_STAFF = [
  ['Service desk', [['#/dashboard', 'Dashboard', '▦'], ['#/work', 'My work', '◉'], ['#/approvals', 'Approvals', '✓', 'pendingApprovals']]],
  ['Tickets', [['#/list/incident', 'Incidents', '⚠'], ['#/list/request', 'Requests', '✉'], ['#/list/problem', 'Problems', '⚙', null, 'problems'], ['#/list/change', 'Changes', '⇄', null, 'changes']]],
  ['Assets & knowledge', [['#/cmdb', 'CMDB', '▣', null, 'cmdb'], ['#/kb', 'Knowledge', '📖'], ['#/catalog', 'Service catalog', '🛒']]],
  ['Insights', [['#/reports', 'Reports & CSAT', '📈', null, 'reports']]],
];
const NAV_REQ = [['Self-service', [['#/home', 'Home', '⌂'], ['#/my', 'My tickets', '☰'], ['#/catalog', 'Request something', '🛒'], ['#/kb', 'Knowledge', '📖'], ['#/approvals', 'Approvals', '✓', 'pendingApprovals']]]];

function renderShell() {
  const app = document.getElementById('app');
  const { user, tenant } = state.me;
  const nav = isStaff() ? [...NAV_STAFF, ...(isAdmin() ? [['Administration', [['#/admin/billing', 'Billing', '💳'], ['#/admin/users', 'Settings', '⚙']]]] : [])] : NAV_REQ;
  app.innerHTML = String(html`<div class="shell">
    <aside class="sidebar" id="sidebar">
      <div class="brand"><div class="brand-mark">A</div><div>Aventra ITSM<small>${tenant.name}</small></div></div>
      <nav class="nav">${nav.map(([sec, links]) => html`<div class="nav-section">${sec}</div>${links.map(([href, text, ico, countKey, feature]) => html`
        <a href="${href}" data-nav><span><span aria-hidden="true" style="display:inline-block;width:20px;opacity:.8">${ico}</span>${text}</span>${countKey && state.me[countKey] ? html`<span class="count">${state.me[countKey]}</span>` : ''}${feature && !hasFeature(feature) ? html`<span class="pro-tag">PRO</span>` : ''}</a>`)}`)}
      </nav>
      <div class="spacer"></div>
      ${isStaff() ? html`<a class="btn primary" href="#/new/incident" style="justify-content:center;margin:8px">+ New incident</a>` : html`<a class="btn primary" href="#/new/incident" style="justify-content:center;margin:8px">Report an issue</a>`}
    </aside>
    <div class="main">
      <header class="topbar">
        <button class="icon-btn menu-toggle" id="menuToggle" aria-label="Menu">☰</button>
        <div class="search"><input type="search" id="gsearch" placeholder="${isStaff() ? 'Search tickets, knowledge, CIs…  (INC0001001)' : 'Search your tickets and help articles'}" autocomplete="off" aria-label="Search"><div class="search-results hidden" id="gresults"></div></div>
        <div class="spacer"></div>
        <div style="position:relative"><button class="icon-btn" id="bell" aria-label="Notifications">🔔${state.me.unread ? html`<span class="dot">${state.me.unread}</span>` : ''}</button><div class="menu hidden" id="bellMenu" style="width:340px"></div></div>
        <div style="position:relative"><button class="user-chip" id="userBtn"><span class="avatar">${initials(user.name)}</span><span class="who"><strong>${user.name}</strong><br><span class="small muted">${user.role}</span></span></button>
          <div class="menu hidden" id="userMenu">
            <div class="small muted" style="padding:6px 10px">${user.email}<br>Workspace: <strong>${tenant.slug}</strong></div>
            <button data-theme-set="light">☀ Light theme</button><button data-theme-set="dark">☾ Dark theme</button><button data-theme-set="">⚙ System theme</button>
            <button id="tzBtn">🕒 Time zone: ${tzAbbr()} <span class="faint small">${state.me.timezone}</span></button>
            ${user.authSource && user.authSource !== 'local' ? '' : html`<button id="pwBtn">Change password</button>`}<button id="logout">Sign out</button>
          </div></div>
      </header>
      <div id="billingBanner">${billingBanner()}</div>
      <main class="content" id="view"></main>
    </div>
  </div>`);

  const $ = (id) => document.getElementById(id);
  $('menuToggle').onclick = () => $('sidebar').classList.toggle('open');
  $('userBtn').onclick = (e) => { e.stopPropagation(); $('userMenu').classList.toggle('hidden'); $('bellMenu').classList.add('hidden'); };
  $('logout').onclick = async () => { await post('/api/auth/logout').catch(() => {}); state.me = null; location.hash = '#/login'; };
  $('tzBtn').onclick = async () => {
    const zones = Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : ['America/Chicago', 'America/New_York', 'America/Denver', 'America/Los_Angeles', 'UTC'];
    const common = ['America/Chicago', 'America/New_York', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'UTC', 'Europe/London', 'Asia/Kolkata'];
    const r = await modal({ title: 'Your time zone', submit: 'Save',
      body: html`<div class="field"><label>Show dates and times in</label><select name="timezone">
        <option value="">Workspace default (${state.me.tenant.timezone})</option>
        <optgroup label="Common">${options(common.map((z) => [z, z]), state.me.user.timezone)}</optgroup>
        <optgroup label="All">${options(zones.filter((z) => !common.includes(z)).map((z) => [z, z]), state.me.user.timezone)}</optgroup></select>
        <div class="hint">America/Chicago is US Central (CST/CDT). Admins set the workspace default in Settings.</div></div>`,
      onSubmit: (d) => patch('/api/auth/profile', { timezone: d.timezone || null }) });
    if (r) { state.me = null; toast('Time zone updated'); document.getElementById('app').innerHTML = ''; route(); }
  };
  if ($('pwBtn')) $('pwBtn').onclick = () => import('./views-auth.js').then((m) => m.changePassword());
  document.querySelectorAll('[data-theme-set]').forEach((b) => b.addEventListener('click', () => setTheme(b.dataset.themeSet)));
  $('bell').onclick = async (e) => {
    e.stopPropagation();
    const menu = $('bellMenu'); $('userMenu').classList.add('hidden');
    if (!menu.classList.contains('hidden')) { menu.classList.add('hidden'); return; }
    const list = await get('/api/notifications');
    menu.innerHTML = String(list.length ? html`${list.map((n) => html`<a href="${n.ticket_id ? `#/tickets/${n.ticket_id}` : '#/dashboard'}" style="${n.read_at ? '' : 'font-weight:600'}">${n.message}<br><span class="small faint">${dt(n.created_at)}</span></a>`)}` : html`<div class="empty">You're all caught up.</div>`);
    menu.classList.remove('hidden');
    if (state.me.unread) { post('/api/notifications/read'); state.me.unread = 0; $('bell').querySelector('.dot')?.remove(); }
  };
  document.addEventListener('click', () => { $('userMenu')?.classList.add('hidden'); $('bellMenu')?.classList.add('hidden'); $('gresults')?.classList.add('hidden'); });

  // Global search
  let timer;
  $('gsearch').addEventListener('input', (e) => {
    clearTimeout(timer);
    const q = e.target.value.trim();
    if (q.length < 2) { $('gresults').classList.add('hidden'); return; }
    timer = setTimeout(async () => {
      const r = await get(`/api/search?q=${encodeURIComponent(q)}`);
      const box = $('gresults');
      const none = !r.tickets.length && !r.kb.length && !r.cis.length;
      box.innerHTML = String(none ? html`<div class="empty small">No matches for “${q}”</div>` : html`
        ${r.tickets.length ? html`<div class="grp">Tickets</div>${r.tickets.map((t) => html`<a href="#/tickets/${t.id}"><strong>${t.number}</strong> ${t.title} <span class="faint small">· ${t.status.replace(/_/g, ' ')}</span></a>`)}` : ''}
        ${r.kb.length ? html`<div class="grp">Knowledge</div>${r.kb.map((k) => html`<a href="#/kb/${k.id}">${k.title}</a>`)}` : ''}
        ${r.cis.length ? html`<div class="grp">Configuration items</div>${r.cis.map((c) => html`<a href="#/cmdb/${c.id}">${c.name} <span class="faint small">· ${c.ci_class}</span></a>`)}` : ''}`);
      box.classList.remove('hidden');
    }, 220);
  });
  $('gsearch').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.target.value = ''; $('gresults').classList.add('hidden'); } });
  $('gresults').addEventListener('click', () => { $('gresults').classList.add('hidden'); $('gsearch').value = ''; });
}

function setTheme(t) {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  try { t ? localStorage.setItem('theme', t) : localStorage.removeItem('theme'); } catch { /* storage unavailable */ }
}
try { const t = localStorage.getItem('theme'); if (t) document.documentElement.dataset.theme = t; } catch { /* ignore */ }

export async function refreshMe() {
  state.me = await get('/api/auth/me');
  prefs.tz = state.me.timezone || undefined;
  if (!state.meta) state.meta = await get('/api/meta');
}

let rendering = 0;
async function route() {
  const [path, qs = ''] = (location.hash.replace(/^#/, '') || '').split('?');
  state.query = new URLSearchParams(qs);
  const my = ++rendering;
  let match; let view; let opts;
  for (const [re, fn, o = {}] of routes) { const m = path.match(re); if (m) { match = m; view = fn; opts = o; break; } }

  if (opts?.public) { state.me = null; const app = document.getElementById('app'); app.innerHTML = ''; return view(app); }
  if (!state.me) {
    try { await refreshMe(); } catch { location.hash = '#/login'; return; }
    renderShell();
  } else if (!document.getElementById('view')) renderShell();
  if (!view) { location.hash = isStaff() ? '#/dashboard' : '#/home'; return; }
  if ((opts.staff && !isStaff()) || (opts.admin && !isAdmin())) { location.hash = isStaff() ? '#/dashboard' : '#/home'; return; }
  const gated = Object.entries(FEATURE_ROUTES).find(([re]) => new RegExp(re).test(path));

  document.querySelectorAll('[data-nav]').forEach((a) => {
    const href = a.getAttribute('href').slice(1);
    a.classList.toggle('active', path === href || (href === '/admin/users' && path.startsWith('/admin') && path !== '/admin/billing') || (href.startsWith('/kb') && path.startsWith('/kb')) || (href === '/cmdb' && path.startsWith('/cmdb')));
  });
  document.getElementById('sidebar')?.classList.remove('open');
  const holder = document.getElementById('view');
  const el = document.createElement('div'); // fresh node per view so delegated listeners never leak
  el.innerHTML = String(html`<div class="empty faint">Loading…</div>`);
  holder.replaceChildren(el);
  if (gated && !hasFeature(gated[1])) { upgradeCard(el, gated[1]); return; }
  try {
    await view(el, ...match.slice(1));
    if (my === rendering) window.scrollTo(0, 0);
  } catch (e) {
    if (e.status === 401) return;
    el.innerHTML = String(html`<div class="card empty"><h2>Couldn't load this page</h2><p class="muted">${e.message}</p><a class="btn" href="#/">Go home</a></div>`);
  }
}

export function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }
export async function refreshBadges() {
  try {
    const me = await get('/api/auth/me'); state.me.pendingApprovals = me.pendingApprovals; state.me.unread = me.unread;
    const a = document.querySelector('a[href="#/approvals"]');
    if (a) { a.querySelector('.count')?.remove(); if (me.pendingApprovals) a.insertAdjacentHTML('beforeend', `<span class="count">${esc(me.pendingApprovals)}</span>`); }
  } catch { /* ignore */ }
}

window.addEventListener('hashchange', route);
// A 402 "subscription required" means billing state changed under us — refresh the banner
window.addEventListener('billing-changed', async () => {
  try { await refreshMe(); const b = document.getElementById('billingBanner'); if (b) b.innerHTML = String(billingBanner()); } catch { /* ignore */ }
});
route();
