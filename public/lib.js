// Shared UI helpers: safe HTML templating, API client, formatting, modals, toasts, markdown.

class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(String(s));
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const val = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(val).join('') : v === false || v == null ? '' : esc(v));
// Tagged template: every interpolation is escaped unless it's html``/raw() output.
export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => { out += val(v) + strings[i + 1]; });
  return new Raw(out);
}

export class ApiError extends Error { constructor(status, msg, details) { super(msg); this.status = status; this.details = details; } }

export async function api(method, path, body) {
  const opts = { method, headers: { 'X-Requested-With': 'itsm' }, credentials: 'same-origin' };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch(path, opts);
  if (r.status === 401 && !path.startsWith('/api/auth/login')) {
    if (!/^#\/(login|signup|forgot|reset)/.test(location.hash)) location.hash = '#/login';
    throw new ApiError(401, 'Please sign in');
  }
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new ApiError(r.status, data?.error || `Request failed (${r.status})`, data?.details);
  return data;
}
export const get = (p) => api('GET', p);
export const post = (p, b = {}) => api('POST', p, b);
export const patch = (p, b) => api('PATCH', p, b);
export const put = (p, b) => api('PUT', p, b);
export const del = (p) => api('DELETE', p);

export function toast(msg, err = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (err ? ' err' : '');
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), err ? 6000 : 3200);
}
export const fail = (e) => toast(e.message || String(e), true);

// Swap a view container for a fresh node so re-renders never stack delegated listeners
export function fresh(el) { const n = document.createElement('div'); el.replaceWith(n); return n; }

// Delegated events scoped to a container
export function on(root, type, selector, fn) {
  root.addEventListener(type, (ev) => {
    const el = ev.target.closest(selector);
    if (el && root.contains(el)) fn(el, ev);
  });
}

export function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.dataset.type === 'int') out[el.name] = el.value === '' ? null : parseInt(el.value, 10);
    else if (el.type === 'datetime-local') out[el.name] = fromLocalInput(el.value);
    else out[el.name] = el.value;
  }
  return out;
}

// Modal returning a promise; resolves with onSubmit's return value, or null if dismissed.
export function modal({ title, body, submit = 'Save', danger = false, onSubmit, wide = false }) {
  return new Promise((resolve) => {
    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.innerHTML = String(html`<form class="modal" style="${wide ? 'width:min(760px,100%)' : ''}" novalidate>
      <header><h2>${title}</h2><button type="button" class="btn ghost sm" data-x aria-label="Close">✕</button></header>
      <div class="mbody">${body}</div>
      <footer><button type="button" class="btn" data-x>Cancel</button>${submit ? html`<button class="btn ${danger ? 'danger' : 'primary'}" type="submit">${submit}</button>` : ''}</footer>
    </form>`);
    const close = (v) => { bg.remove(); document.removeEventListener('keydown', key); resolve(v); };
    const key = (e) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', key);
    bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(null); });
    bg.querySelectorAll('[data-x]').forEach((b) => b.addEventListener('click', () => close(null)));
    const form = bg.querySelector('form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try { close(onSubmit ? await onSubmit(formData(form), form) : formData(form)); } catch (err) { fail(err); btn.disabled = false; }
    });
    document.body.appendChild(bg);
    setTimeout(() => form.querySelector('input:not([type=hidden]),select,textarea')?.focus(), 30);
  });
}

// ---------- formatting
export const initials = (n = '?') => n.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
export const label = (s) => String(s ?? '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
export function timeAgo(d) {
  if (!d) return '';
  const s = (Date.now() - new Date(d)) / 1000;
  const f = (n, u) => `${Math.floor(n)}${u} ago`;
  if (s < 60) return 'just now';
  if (s < 3600) return f(s / 60, 'm'); if (s < 86400) return f(s / 3600, 'h'); if (s < 86400 * 30) return f(s / 86400, 'd');
  return dateOnly(d);
}
// All dates render in the user's (or workspace's) time zone, e.g. America/Chicago (CST/CDT).
export const prefs = { tz: undefined };
export const tzAbbr = () => { try { return new Intl.DateTimeFormat('en-US', { timeZone: prefs.tz, timeZoneName: 'short' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value || ''; } catch { return ''; } };
export const dt = (d) => (d ? new Date(d).toLocaleString('en-US', { timeZone: prefs.tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }) : '—');
export const dateOnly = (d) => (d ? new Date(d).toLocaleDateString('en-US', { timeZone: prefs.tz, month: 'short', day: 'numeric', year: 'numeric' }) : '—');
function tzOffsetMs(date, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(date).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(date.getTime() / 1000) * 1000;
}
// <input type=datetime-local> values are wall-clock times in prefs.tz
export const toLocalInput = (d) => { if (!d) return ''; const x = new Date(d); return new Date(x.getTime() + tzOffsetMs(x, prefs.tz)).toISOString().slice(0, 16); };
export const fromLocalInput = (s) => { if (!s) return null; const guess = new Date(s + ':00Z'); return new Date(guess.getTime() - tzOffsetMs(guess, prefs.tz)).toISOString(); };
export function dur(ms) {
  const m = Math.abs(ms) / 60000;
  if (m < 60) return `${Math.floor(m)}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h ${Math.floor(m % 60)}m`;
  return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
}

const PRI = { 1: 'Critical', 2: 'High', 3: 'Moderate', 4: 'Low' };
export const priorityBadge = (p) => html`<span class="badge p${p}">P${p} ${PRI[p]}</span>`;
const STATUS_CLASS = {
  new: 'st-open', submitted: 'st-open', draft: 'st-closed', assess: 'st-open', in_progress: 'st-open', investigating: 'st-open', implementing: 'st-open',
  on_hold: 'st-wait', pending_approval: 'st-wait', known_error: 'st-wait', review: 'st-wait', approved: 'st-open', scheduled: 'st-open',
  resolved: 'st-done', fulfilled: 'st-done', closed: 'st-closed', canceled: 'st-closed', rejected: 'st-bad',
};
export const statusBadge = (s) => html`<span class="badge ${STATUS_CLASS[s] || ''}">${label(s)}</span>`;
export const TYPE_LABEL = { incident: 'Incident', request: 'Request', problem: 'Problem', change: 'Change' };

export function slaInfo(t) {
  if (!t.resolve_due) return null;
  if (t.resolved_at) return t.sla_breached ? html`<span class="sla breach">✕ SLA missed</span>` : html`<span class="sla ok">✓ SLA met</span>`;
  if (t.sla_paused_at) return html`<span class="sla paused">⏸ Paused</span>`;
  const left = new Date(t.resolve_due) - Date.now();
  if (left < 0 || t.sla_breached) return html`<span class="sla breach" title="Due ${dt(t.resolve_due)}">⚠ Breached ${dur(left)}</span>`;
  const total = new Date(t.resolve_due) - new Date(t.created_at);
  const cls = left < total * 0.2 ? 'warn' : 'ok';
  return html`<span class="sla ${cls}" title="Due ${dt(t.resolve_due)}">${cls === 'warn' ? '◔' : '◷'} ${dur(left)} left</span>`;
}

// ---------- tiny, safe markdown (escape first, then format)
export function md(src = '') {
  const lines = esc(src).split('\n');
  let out = ''; let list = null; let code = false;
  const inline = (s) => s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\W)\*([^*]+)\*(?=\W|$)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  const closeList = () => { if (list) { out += `</${list}>`; list = null; } };
  for (const l of lines) {
    if (l.startsWith('```')) { closeList(); out += code ? '</pre>' : '<pre>'; code = !code; continue; }
    if (code) { out += l + '\n'; continue; }
    let m;
    if ((m = l.match(/^(#{1,3})\s+(.*)/))) { closeList(); const n = Math.min(m[1].length + 1, 3); out += `<h${n}>${inline(m[2])}</h${n}>`; }
    else if ((m = l.match(/^\s*[-*]\s+(.*)/))) { if (list !== 'ul') { closeList(); out += '<ul>'; list = 'ul'; } out += `<li>${inline(m[1])}</li>`; }
    else if ((m = l.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== 'ol') { closeList(); out += '<ol>'; list = 'ol'; } out += `<li>${inline(m[1])}</li>`; }
    else if (!l.trim()) closeList();
    else { closeList(); out += `<p>${inline(l)}</p>`; }
  }
  closeList(); if (code) out += '</pre>';
  return raw(out);
}

export const options = (items, selected, { blank } = {}) => html`${blank !== undefined ? html`<option value="">${blank}</option>` : ''}${items.map((i) => {
  const [v, t] = Array.isArray(i) ? i : typeof i === 'object' ? [i.id, i.name] : [i, label(i)];
  return html`<option value="${v}" ${String(v) === String(selected ?? '') ? raw('selected') : ''}>${t}</option>`;
})}`;
