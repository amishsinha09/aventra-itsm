import { html, raw, get, esc, priorityBadge, statusBadge, slaInfo, dt, timeAgo, tzAbbr, on } from './lib.js';
import { state } from './app.js';
import { ticketTable } from './views-tickets.js';

// Grouped column chart (≤ 2 series) with legend, hover tooltips and a recessive grid.
function columnChart(rows, series, { height = 200 } = {}) {
  const W = 640; const H = height; const pad = { l: 28, r: 8, t: 8, b: 22 };
  const max = Math.max(1, ...rows.flatMap((r) => series.map((s) => r[s.key])));
  const step = max <= 5 ? 1 : Math.ceil(max / 4);
  const top = Math.ceil(max / step) * step;
  const iw = W - pad.l - pad.r; const ih = H - pad.t - pad.b;
  const bw = iw / rows.length; const gap = 2; const barW = Math.max(3, Math.min(14, (bw - 8) / series.length - gap));
  const y = (v) => pad.t + ih - (v / top) * ih;
  let g = '';
  for (let v = 0; v <= top; v += step) g += `<line class="${v === 0 ? 'axis' : 'grid-line'}" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end" class="num">${v}</text>`;
  rows.forEach((r, i) => {
    const cx = pad.l + bw * i + bw / 2; const groupW = series.length * barW + (series.length - 1) * gap;
    const tip = `${r.label}: ${series.map((s) => `${s.name} ${r[s.key]}`).join(' · ')}`;
    g += `<g class="col" data-tip="${esc(tip)}" data-x="${cx / W}"><rect class="hl" x="${pad.l + bw * i}" y="${pad.t}" width="${bw}" height="${ih}" fill="transparent" rx="4"/>`;
    series.forEach((s, j) => {
      const v = r[s.key]; if (!v) return;
      const x = cx - groupW / 2 + j * (barW + gap); const h = Math.max(2, (v / top) * ih);
      g += `<path class="${s.cls}" d="M${x},${y(0)} v${-(h - 4)} q0,-4 4,-4 h${barW - 8} q4,0 4,4 v${h - 4} z"/>`;
    });
    if (i % 2 === 0 || rows.length <= 8) g += `<text x="${cx}" y="${H - 6}" text-anchor="middle">${esc(r.short)}</text>`;
    g += '</g>';
  });
  return html`<div class="chart" data-chart>
    ${series.length > 1 ? html`<div class="legend">${series.map((s) => html`<span style="--c: var(--${s.cls})">${s.name}</span>`)}</div>` : ''}
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${series.map((s) => s.name).join(' and ')} per day">${raw(g)}</svg>
    <div class="tooltip hidden"></div></div>`;
}

function bindTooltips(root) {
  root.querySelectorAll('[data-chart]').forEach((c) => {
    const tip = c.querySelector('.tooltip');
    c.querySelectorAll('g.col').forEach((g) => {
      g.addEventListener('mouseenter', () => {
        const box = g.getBoundingClientRect(); const cb = c.getBoundingClientRect();
        tip.textContent = g.dataset.tip; tip.classList.remove('hidden');
        tip.style.left = `${box.left - cb.left + box.width / 2}px`; tip.style.top = `${box.top - cb.top + 20}px`;
      });
      g.addEventListener('mouseleave', () => tip.classList.add('hidden'));
    });
  });
}

const hbars = (rows, key, lab, href) => {
  const max = Math.max(1, ...rows.map((r) => r[key]));
  return html`${rows.map((r) => html`<a class="hbar" href="${href ? href(r) : '#'}" style="color:inherit;text-decoration:none"><span>${lab(r)}</span>
    <span class="track"><span class="fill" style="display:block;width:${(r[key] / max) * 100}%"></span></span><span class="n">${r[key]}</span></a>`)}`;
};

export async function dashboardView(el) {
  const d = await get('/api/dashboard');
  const c = d.counts;
  const trend = d.trend.map((r) => ({ ...r, label: new Date(r.day + 'T12:00').toLocaleDateString([], { month: 'short', day: 'numeric' }), short: new Date(r.day + 'T12:00').toLocaleDateString([], { day: 'numeric' }) }));
  const pr = [1, 2, 3, 4].map((p) => ({ priority: p, n: d.byPriority.find((x) => x.priority === p)?.n || 0 }));
  el.innerHTML = String(html`
    <div class="page-head"><div><h1>Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening'}, ${state.me.user.name.split(' ')[0]}</h1><p>Here's the state of service across ${esc(state.me.tenant.name)}.</p></div>
      <div class="btn-row"><a class="btn" href="#/new/change">New change</a><a class="btn primary" href="#/new/incident">New incident</a></div></div>
    <div class="grid g5">
      <a class="stat hero" href="#/list/incident"><div class="label">Open incidents</div><div class="value">${c.open_incidents}</div><div class="sub">${c.p1_open ? html`<span style="color:var(--critical);font-weight:600">● ${c.p1_open} critical (P1)</span>` : 'No P1s open'}</div></a>
      <div class="stat"><div class="label">SLA met · 30 days</div><div class="value">${d.sla.pct == null ? '—' : `${d.sla.pct}%`}</div><div class="sub">${d.sla.met} of ${d.sla.total} resolved on time</div></div>
      <div class="stat"><div class="label">Self-healed · 30 days</div><div class="value">${d.auto.pct == null ? '—' : `${d.auto.pct}%`}</div><div class="sub">${d.auto.auto} incidents fixed by Aventra${d.auto_mttr_minutes ? ` · ${d.auto_mttr_minutes}m avg` : ''}</div></div>
      <div class="stat"><div class="label">Mean time to resolve</div><div class="value">${d.mttr_hours == null ? '—' : `${d.mttr_hours}h`}</div><div class="sub">Incidents, last 30 days</div></div>
      <a class="stat ${c.breached_open ? 'alert' : ''}" href="#/list/incident?breached=true"><div class="label">SLA breached (open)</div><div class="value">${c.breached_open}</div><div class="sub">${c.unassigned} unassigned tickets</div></a>
    </div>
    <div class="grid g4" style="margin-top:14px">
      <a class="stat" href="#/reports"><div class="label">Customer satisfaction · 30 days</div><div class="value">${d.csat.avg == null ? '—' : html`${d.csat.avg}<span style="font-size:15px;color:var(--ink-3)"> / 5</span>`}</div><div class="sub">${d.csat.responses ? `${d.csat.pct}% satisfied · ${d.csat.responses} responses` : 'No survey responses yet'}</div></a>
      <a class="stat" href="#/list/request"><div class="label">Open requests</div><div class="value">${c.open_requests}</div></a>
      <a class="stat" href="#/list/problem"><div class="label">Open problems</div><div class="value">${c.open_problems}</div></a>
      <a class="stat" href="#/list/change"><div class="label">Changes in flight</div><div class="value">${c.open_changes}</div></a>
    </div>
    <div class="split" style="margin-top:14px">
      <div class="card"><div class="card-head"><h2>Tickets created vs resolved</h2><span class="small faint">Last 14 days · ${tzAbbr()}</span></div>
        ${columnChart(trend, [{ key: 'created', name: 'Created', cls: 's1' }, { key: 'resolved', name: 'Resolved', cls: 's2' }])}</div>
      <div class="card"><div class="card-head"><h2>Open by priority</h2></div>
        ${hbars(pr, 'n', (r) => priorityBadge(r.priority), (r) => `#/list/incident?priority=${r.priority}`)}
        <div class="divider"></div><h3 style="margin-bottom:8px">Backlog age</h3>
        ${hbars(d.aging, 'n', (r) => r.bucket)}</div>
    </div>
    <div class="grid g3" style="margin-top:14px">
      <div class="card"><div class="card-head"><h2>Open by category</h2></div>${d.byCategory.length ? hbars(d.byCategory, 'n', (r) => r.category) : html`<div class="empty small">Nothing open</div>`}</div>
      <div class="card"><div class="card-head"><h2>Team workload</h2></div>${hbars(d.groups, 'open', (r) => r.name, (r) => `#/list/incident?group=${r.id}`)}</div>
      <div class="card"><div class="card-head"><h2>Upcoming changes</h2><a class="small" href="#/list/change">All</a></div>
        ${d.upcoming.length ? html`<div class="list-links">${d.upcoming.map((u) => html`<a href="#/tickets/${u.id}"><strong>${u.number}</strong> ${u.title}<br><span class="small muted">${dt(u.planned_start)} · <span class="risk-${u.risk}">${u.risk} risk</span> · ${u.status.replace(/_/g, ' ')}</span></a>`)}</div>` : html`<div class="empty small">No changes scheduled in the next 2 weeks</div>`}</div>
    </div>`);
  bindTooltips(el);
}

export async function workView(el) {
  const [mine, queue] = await Promise.all([
    get('/api/tickets?assignee=me&open=true&sort=priority&limit=100'),
    get('/api/tickets?group=mine&assignee=none&open=true&sort=priority&limit=100'),
  ]);
  el.innerHTML = String(html`<div class="page-head"><div><h1>My work</h1><p>Tickets assigned to you and unassigned work in your groups.</p></div></div>
    <div class="card-head"><h2>Assigned to me <span class="faint">(${mine.total})</span></h2></div>
    ${ticketTable(mine.rows, { empty: 'Nothing assigned to you. Nice.' })}
    <div class="card-head" style="margin-top:22px"><h2>Unassigned in my groups <span class="faint">(${queue.total})</span></h2></div>
    ${ticketTable(queue.rows, { empty: 'Your group queues are empty.' })}`);
  el.querySelectorAll('tr[data-href]').forEach((tr) => tr.addEventListener('click', () => { location.hash = tr.dataset.href; }));
}

const stars = (n) => html`<span aria-label="${n} out of 5" style="color:#c98500;letter-spacing:1px">${'★'.repeat(n)}<span style="color:var(--line-2)">${'★'.repeat(5 - n)}</span></span>`;
const pctCell = (v, good = 95, ok = 85) => (v == null ? html`<span class="faint">—</span>` : html`<span class="${v >= good ? 'sla ok' : v >= ok ? 'sla warn' : 'sla breach'}">${v}%</span>`);

export async function reportsView(el) {
  const days = +(state.query.get('days') || 30);
  const r = await get(`/api/reports?days=${days}`);
  const totalCsat = r.csatDistribution.reduce((a, b) => a + b.n, 0);
  const avg = totalCsat ? (r.csatDistribution.reduce((a, b) => a + b.score * b.n, 0) / totalCsat).toFixed(2) : null;
  const table = (rows, kind) => { const agent = kind === 'Assignee'; return rows.length ? html`<div class="table-wrap"><table><thead><tr><th>${kind}</th><th>${agent ? 'Assigned' : 'Created'}</th><th>Resolved</th><th>Open</th><th>SLA met</th><th>MTTR (incidents)</th>${agent ? '' : html`<th>Self-healed</th>`}<th>CSAT</th></tr></thead><tbody>
    ${rows.map((x) => html`<tr><td><strong>${x.name}</strong></td><td class="num">${x.created}</td><td class="num">${x.resolved}</td><td class="num">${x.open}</td>
      <td>${pctCell(x.sla_pct)} <span class="small faint">${x.sla_total ? `${x.sla_met}/${x.sla_total}` : ''}</span></td>
      <td class="num">${x.mttr_hours == null ? '—' : `${x.mttr_hours}h`}</td>${agent ? '' : html`<td>${x.incidents ? html`${x.auto_pct}% <span class="small faint">(${x.auto})</span>` : html`<span class="faint">—</span>`}</td>`}
      <td>${x.csat_avg == null ? html`<span class="faint">—</span>` : html`<strong>${x.csat_avg}</strong> <span class="small faint">(${x.csat_n})</span>`}</td></tr>`)}</tbody></table></div>` : html`<div class="table-wrap"><div class="empty">No activity in this period.</div></div>`; };
  el.innerHTML = String(html`<div class="page-head"><div><h1>Reports & customer satisfaction</h1><p>Scorecards per customer and per technician. Times in ${r.timezone} (${tzAbbr()}).</p></div>
    <div class="seg" role="group" aria-label="Period">${[7, 30, 90, 365].map((d) => html`<button type="button" data-days="${d}" class="${d === r.days ? 'on' : ''}">${d === 365 ? '12 months' : `${d} days`}</button>`)}</div></div>
    <div class="split">
      <div class="stack"><div class="card-head"><h2>Customers</h2><span class="small faint">MSP client scorecard</span></div>${table(r.companies, 'Company')}
        <div class="card-head" style="margin-top:18px"><h2>Technicians</h2></div>${table(r.agents, 'Assignee')}</div>
      <div class="stack"><div class="card"><div class="card-head"><h2>CSAT</h2><span class="small faint">${totalCsat} responses</span></div>
        <div class="value" style="font-size:34px;font-weight:650">${avg ?? '—'}<span style="font-size:15px;color:var(--ink-3)"> / 5</span></div>
        <div style="margin-top:10px">${[5, 4, 3, 2, 1].map((s) => { const n = r.csatDistribution.find((x) => x.score === s).n; return html`<div class="hbar" style="grid-template-columns:80px 1fr 30px"><span>${stars(s)}</span><span class="track"><span class="fill" style="display:block;width:${totalCsat ? (n / totalCsat) * 100 : 0}%"></span></span><span class="n">${n}</span></div>`; })}</div></div>
      <div class="card"><h2 style="margin-bottom:8px">Latest feedback</h2>${r.comments.length ? html`<div class="list-links" style="max-height:560px;overflow:auto">${r.comments.slice(0, 10).map((c) => html`<a href="#/tickets/${c.id}">${stars(c.csat_score)} <strong>${c.number}</strong><br>${c.csat_comment ? html`<span class="muted">“${c.csat_comment}”</span><br>` : ''}<span class="small faint">${c.requester_name}${c.company_name ? ` · ${c.company_name}` : ''} · ${timeAgo(c.csat_at)}${c.assignee_name ? ` · handled by ${c.assignee_name}` : ''}</span></a>`)}</div>` : html`<div class="small faint">Requesters are asked to rate each resolved incident and request.</div>`}</div></div>
    </div>`);
  on(el, 'click', '[data-days]', (b) => { location.hash = `#/reports?days=${b.dataset.days}`; });
}
