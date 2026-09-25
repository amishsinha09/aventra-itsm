import { fresh, html, raw, get, post, on, toast, fail, modal, dateOnly, esc } from './lib.js';
import { state, refreshMe } from './app.js';

const money = (n) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
const FEATURE_ROWS = [
  ['Incident & request management', true, true], ['Self-service portal & service catalog', true, true], ['Knowledge base with deflection', true, true],
  ['SLA timers, pause & breach alerts', true, true], ['CSAT surveys', true, true], ['Email-to-ticket', true, true], ['Unlimited requesters (end users)', true, true],
  ['Problem management', false, true], ['Change management with CAB approvals & risk scoring', false, true], ['CMDB with impact analysis', false, true],
  ['AI triage, draft replies & KB drafting', false, true], ['Reports & per-customer scorecards', false, true], ['Aventra self-healing integration', false, true],
];

// ------------------------------------------------------------------ Public pricing page
export async function pricingView(app) {
  const p = await get('/api/billing/plans');
  let annual = true;
  const render = () => {
    const card = (pl) => html`<div class="price-card ${pl.recommended ? 'rec' : ''}">
      ${pl.recommended ? html`<div class="rec-tag">Most popular</div>` : ''}
      <h2>${pl.name}</h2>
      <div class="price"><span class="amt">${money(annual ? pl.annualPerMonth : pl.monthly)}</span><span class="per">/ technician / month</span></div>
      <div class="small muted">${annual ? `billed yearly (${money(pl.monthly * 10)} per technician) — 2 months free` : 'billed monthly'}</div>
      <a class="btn ${pl.recommended ? 'primary' : ''}" style="width:100%;justify-content:center;margin:16px 0" href="#/signup?plan=${pl.id}">Start 14-day free trial</a>
      <ul class="checks">${pl.features.map((f) => html`<li>${f}</li>`)}</ul></div>`;
    app.innerHTML = String(html`<div class="mkt">
      <header class="mkt-nav"><a class="brand" href="#/pricing" style="padding:0;color:inherit"><div class="brand-mark">A</div><div>Aventra ITSM</div></a>
        <span class="spacer"></span><a href="#/login">Sign in</a><a class="btn primary" href="#/signup?plan=pro">Start free trial</a></header>
      <section class="mkt-hero"><h1>ITSM that fixes things before your users notice</h1>
        <p>Incidents, requests, problems, changes, CMDB and knowledge — connected to Aventra's self-healing agent. Priced per technician. End users are always free.</p>
        <div class="seg" role="group" aria-label="Billing period"><button type="button" data-annual="0" class="${annual ? '' : 'on'}">Monthly</button><button type="button" data-annual="1" class="${annual ? 'on' : ''}">Yearly · 2 months free</button></div></section>
      <section class="price-grid">${p.plans.map(card)}
        <div class="price-card"><h2>On-prem / Enterprise</h2><div class="price"><span class="amt" style="font-size:30px">Custom</span></div>
          <div class="small muted">annual license</div>
          <a class="btn" style="width:100%;justify-content:center;margin:16px 0" href="mailto:${p.salesEmail}?subject=Aventra%20ITSM%20on-prem">Talk to sales</a>
          <ul class="checks"><li>Everything in Pro</li><li>Runs on your own Windows server</li><li>Bundled database, no cloud dependency</li><li>Signed offline license</li><li>Priority support & onboarding</li></ul></div></section>
      <section class="mkt-section"><h2>Compare plans</h2><div class="table-wrap"><table><thead><tr><th>Feature</th><th>Starter</th><th>Pro</th></tr></thead><tbody>
        ${FEATURE_ROWS.map(([f, s, pr]) => html`<tr><td>${f}</td><td>${s ? html`<span class="yes" aria-label="Included">✓</span>` : html`<span class="faint" aria-label="Not included">—</span>`}</td><td>${pr ? html`<span class="yes" aria-label="Included">✓</span>` : '—'}</td></tr>`)}</tbody></table></div></section>
      <section class="mkt-section faq"><h2>Questions</h2>
        <details open><summary>Who counts as a technician?</summary><p>Anyone who works tickets — agents and admins. Requesters who raise tickets through the portal or email are free and unlimited.</p></details>
        <details><summary>Do I need a credit card for the trial?</summary><p>No. You get 14 days of Pro with up to ${p.trialSeats} technicians. Pick a plan any time — if you subscribe during the trial, billing starts when the trial ends.</p></details>
        <details><summary>What happens if I don't subscribe?</summary><p>Your workspace becomes read-only. Nothing is deleted — choose a plan and you pick up exactly where you left off.</p></details>
        <details><summary>Can I change plans or seats later?</summary><p>Yes, any time from Settings → Billing. Changes are prorated automatically.</p></details>
        <details><summary>How does this compare to ServiceNow?</summary><p>Aventra ITSM covers the core ITSM processes MSPs and mid-size IT teams use every day, sets up in minutes instead of months, and adds self-healing automation — at a fraction of the per-seat price and with no implementation partner required.</p></details>
      </section>
      <footer class="mkt-foot small muted">© Aventra Tech · <a href="${state.marketingUrl || 'https://aventratech.org'}">aventratech.org</a> · <a href="mailto:${p.salesEmail}">${p.salesEmail}</a></footer></div>`);
    on(app, 'click', '[data-annual]', (b) => { annual = b.dataset.annual === '1'; render(); });
  };
  render();
}

// ------------------------------------------------------------------ Settings → Billing
export async function billingTab(box) {
  const b = await get('/api/billing');
  const qs = state.query;
  if (qs.get('checkout') === 'success' && b.status !== 'active') return waitForActivation(box);
  if (qs.get('checkout') === 'canceled') toast('Checkout canceled — no charge was made.');

  if (b.mode === 'off') {
    box.innerHTML = String(html`<div class="card"><h2>Billing is turned off on this server</h2><p class="muted">All features are unlocked. Set STRIPE_SECRET_KEY (cloud) or run the on-prem edition to enable billing.</p></div>`);
    return;
  }
  if (b.mode === 'license') return licenseTab(box, b);

  const statusLine = b.status === 'comped' ? html`<span class="badge st-done">Complimentary</span>`
    : b.status === 'trialing' ? html`<span class="badge st-open">Pro trial · ${b.trialDaysLeft} day${b.trialDaysLeft === 1 ? '' : 's'} left</span>`
      : b.status === 'active' ? html`<span class="badge st-done">Active</span>`
        : b.status === 'past_due' ? html`<span class="badge st-wait">Payment overdue</span>` : html`<span class="badge st-bad">Inactive</span>`;
  const planName = b.plan === 'trial' ? 'Pro (trial)' : b.plan === 'starter' ? 'Starter' : 'Pro';

  const summary = html`<div class="card"><div class="card-head"><h2>Current plan</h2>${statusLine}</div>
    <div class="grid g4">
      <div><div class="small muted">Plan</div><div class="big">${planName}</div></div>
      <div><div class="small muted">Technician seats</div><div class="big">${b.seatsUsed}${b.seats ? html` <span class="faint">/ ${b.seats}</span>` : ''}</div><div class="meter"><span style="width:${b.seats ? Math.min(100, (b.seatsUsed / b.seats) * 100) : 0}%;background:var(--accent)"></span></div></div>
      <div><div class="small muted">Requesters</div><div class="big">${b.requesters}</div><div class="small faint">always free</div></div>
      <div><div class="small muted">${b.status === 'trialing' ? 'Trial ends' : b.cancelAtPeriodEnd ? 'Ends on' : 'Renews'}</div><div class="big">${b.status === 'trialing' ? dateOnly(b.trialEndsAt) : b.periodEnd ? dateOnly(b.periodEnd) : '—'}</div>${b.interval ? html`<div class="small faint">billed ${b.interval === 'year' ? 'yearly' : 'monthly'}</div>` : ''}</div>
    </div>
    ${b.message ? html`<div class="notice ${b.readOnly ? 'bad' : 'warn'}" style="margin-top:14px">${b.message}</div>` : ''}
    ${b.hasSubscription ? html`<div class="btn-row" style="margin-top:14px"><button class="btn primary" data-act="portal">Manage billing, invoices & plan</button><button class="btn" data-act="seats">Change seats</button></div>` : ''}</div>`;

  if (b.hasSubscription || b.status === 'comped') { box.innerHTML = String(summary); bind(); return; }

  const plans = await get('/api/billing/plans');
  let interval = 'year';
  const draw = () => {
    box.innerHTML = String(html`${summary}
      <div class="card"><div class="card-head"><h2>Choose a plan</h2><div class="seg"><button type="button" data-int="month" class="${interval === 'month' ? 'on' : ''}">Monthly</button><button type="button" data-int="year" class="${interval === 'year' ? 'on' : ''}">Yearly · 2 months free</button></div></div>
        ${!b.pricesConfigured ? html`<div class="notice warn" style="margin-bottom:12px">Stripe prices aren't configured yet — run <code>npm run stripe:setup</code> and set the STRIPE_PRICE_* variables.</div>` : ''}
        <div class="field" style="max-width:260px"><label for="seats">Technician seats</label><input id="seats" type="number" min="${Math.max(1, b.seatsUsed)}" value="${Math.max(1, b.seatsUsed)}"><div class="hint">You have ${b.seatsUsed} active technician${b.seatsUsed === 1 ? '' : 's'}. Requesters are free.</div></div>
        <div class="grid g2">${plans.plans.map((pl) => html`<div class="price-card ${pl.recommended ? 'rec' : ''}" style="margin:0">
          <h2>${pl.name}</h2><div class="price"><span class="amt">${money(interval === 'year' ? pl.annualPerMonth : pl.monthly)}</span><span class="per">/ technician / month</span></div>
          <div class="small muted" data-total="${pl.id}"></div>
          <button class="btn ${pl.recommended ? 'primary' : ''}" style="width:100%;justify-content:center;margin:14px 0" data-plan="${pl.id}">Choose ${pl.name}</button>
          <ul class="checks">${pl.features.map((f) => html`<li>${f}</li>`)}</ul></div>`)}</div>
        <p class="small muted" style="margin-top:12px">Secure checkout by Stripe. ${b.status === 'trialing' && b.trialDaysLeft > 2 ? 'Your trial continues — the first charge happens when it ends.' : ''} Cancel any time.</p></div>`);
    const totals = () => {
      const n = Math.max(1, parseInt(box.querySelector('#seats').value, 10) || 1);
      for (const pl of plans.plans) {
        const el = box.querySelector(`[data-total="${pl.id}"]`);
        el.textContent = interval === 'year' ? `${money(pl.monthly * 10 * n)} per year for ${n} seat${n === 1 ? '' : 's'}` : `${money(pl.monthly * n)} per month for ${n} seat${n === 1 ? '' : 's'}`;
      }
    };
    totals();
    box.querySelector('#seats').addEventListener('input', totals);
    bind();
  };
  function bind() {
    on(box, 'click', '[data-int]', (btn) => { interval = btn.dataset.int; draw(); });
    on(box, 'click', '[data-plan]', async (btn) => {
      btn.disabled = true; btn.textContent = 'Opening secure checkout…';
      try { const r = await post('/api/billing/checkout', { plan: btn.dataset.plan, interval, seats: parseInt(box.querySelector('#seats').value, 10) || 1 }); location.href = r.url; } catch (e) { fail(e); btn.disabled = false; btn.textContent = 'Try again'; }
    });
    on(box, 'click', '[data-act=portal]', async (btn) => { btn.disabled = true; try { location.href = (await post('/api/billing/portal')).url; } catch (e) { fail(e); btn.disabled = false; } });
    on(box, 'click', '[data-act=seats]', async () => {
      const r = await modal({ title: 'Change technician seats', submit: 'Update seats',
        body: html`<div class="field"><label>Seats</label><input name="seats" type="number" min="${b.seatsUsed}" value="${b.seats}" data-type="int"><div class="hint">${b.seatsUsed} in use. Changes are prorated on your next invoice.</div></div>`,
        onSubmit: (d) => post('/api/billing/seats', { seats: d.seats }) });
      if (r) { toast(`Seats updated to ${r.seats}`); billingTab(fresh(box)); }
    });
  }
  draw();
}

async function waitForActivation(box) {
  box.innerHTML = String(html`<div class="card empty"><h2>Payment received — activating your subscription…</h2><p class="muted">This usually takes a few seconds.</p></div>`);
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const b = await get('/api/billing').catch(() => null);
    if (b && b.status === 'active' && b.hasSubscription) {
      toast('Subscription active — thank you!');
      await refreshMe().catch(() => {});
      location.hash = '#/admin/billing';
      return;
    }
  }
  box.innerHTML = String(html`<div class="card empty"><h2>Still confirming your payment</h2><p class="muted">Stripe hasn't confirmed yet. Refresh in a minute — you won't be charged twice.</p><a class="btn" href="#/admin/billing">Refresh</a></div>`);
}

function licenseTab(box, b) {
  box.innerHTML = String(html`<div class="card"><div class="card-head"><h2>License</h2>${b.license ? html`<span class="badge ${b.readOnly ? 'st-bad' : b.status === 'past_due' ? 'st-wait' : 'st-done'}">${b.readOnly ? 'Expired' : b.status === 'past_due' ? 'Expired · grace period' : 'Active'}</span>` : html`<span class="badge st-open">Trial · ${b.trialDaysLeft ?? 0} days left</span>`}</div>
    ${b.license ? html`<div class="kv"><div>Licensed to</div><div><strong>${b.license.licensee}</strong></div><div>Plan</div><div>${b.license.plan === 'starter' ? 'Starter' : 'Pro'}</div>
      <div>Technician seats</div><div>${b.seatsUsed} used of ${b.license.seats}</div><div>Expires</div><div>${dateOnly(b.license.expires)}</div><div>License ID</div><div><code>${b.license.id || '—'}</code></div></div>`
    : html`<p class="muted">This server is running a 30-day evaluation with all Pro features and up to 10 technicians. Activate a license to keep using it after the trial.</p>`}
    ${b.message ? html`<div class="notice ${b.readOnly ? 'bad' : 'warn'}" style="margin-top:12px">${b.message}</div>` : ''}
    ${!b.licensingConfigured ? html`<div class="notice warn" style="margin-top:12px">This build has no license public key. Run <code>node scripts/license.js keygen</code> and rebuild the installer.</div>` : ''}</div>
    <form class="card" id="lic"><h2 style="margin-bottom:8px">${b.license ? 'Renew or change license' : 'Activate a license'}</h2>
      <div class="field"><label for="key">License key</label><textarea id="key" name="key" rows="4" placeholder="AVL1.…" style="font-family:ui-monospace,monospace;font-size:12px" required></textarea></div>
      <div class="btn-row"><button class="btn primary" type="submit">Activate</button><a class="btn" href="mailto:sales@aventratech.org?subject=Aventra%20ITSM%20license">Buy or renew a license</a></div></form>`);
  box.querySelector('#lic').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await post('/api/license', { key: e.target.key.value }); toast('License activated'); await refreshMe(); location.reload(); } catch (err) { fail(err); }
  });
}

// ------------------------------------------------------------------ Banner + upgrade card used by the shell
export function billingBanner() {
  const b = state.me?.billing;
  if (!b || b.mode === 'off' || b.status === 'comped') return '';
  const admin = state.me.user.role === 'admin';
  const cta = admin ? html`<a class="btn sm ${b.readOnly ? 'primary' : ''}" href="#/admin/billing">${b.mode === 'license' ? 'Activate license' : 'Choose a plan'}</a>` : html`<span class="small">Contact your administrator.</span>`;
  if (b.readOnly) return html`<div class="banner bad" role="alert"><strong>Read-only.</strong> ${b.message} ${cta}</div>`;
  if (b.status === 'past_due') return html`<div class="banner warn" role="status">${b.message} ${admin ? html`<a class="btn sm" href="#/admin/billing">Update billing</a>` : ''}</div>`;
  if (b.status === 'trialing' && ['admin', 'agent'].includes(state.me.user.role)) {
    return html`<div class="banner info">${b.mode === 'license' ? 'Evaluation' : 'Pro trial'}: <strong>${b.trialDaysLeft} day${b.trialDaysLeft === 1 ? '' : 's'} left</strong> ${admin ? cta : ''}</div>`;
  }
  if (b.cancelAtPeriodEnd && admin) return html`<div class="banner info">Your subscription ends on ${dateOnly(b.periodEnd)}. <a class="btn sm" href="#/admin/billing">Keep my plan</a></div>`;
  return '';
}

const FEATURE_TEXT = {
  problems: ['Problem management', 'Find and fix the root causes behind recurring incidents. Resolving a problem resolves every linked incident.'],
  changes: ['Change management', 'Plan changes with automatic risk scoring, CAB approvals and schedule-conflict detection.'],
  cmdb: ['CMDB & impact analysis', 'Track every device, application and service — and see what breaks when one goes down.'],
  reports: ['Reports & CSAT scorecards', 'Per-customer and per-technician SLA, MTTR, self-heal rate and satisfaction.'],
};
export function upgradeCard(el, feature) {
  const [title, text] = FEATURE_TEXT[feature] || ['This feature', ''];
  const admin = state.me.user.role === 'admin';
  el.innerHTML = String(html`<div class="card empty" style="max-width:640px;margin:40px auto"><div class="tag" style="margin-bottom:10px">PRO</div>
    <h1>${title}</h1><p class="muted" style="margin:10px 0 18px">${text} It's included in the Pro plan.</p>
    ${admin ? html`<a class="btn primary" href="#/admin/billing">Upgrade to Pro</a>` : html`<p class="small muted">Ask your administrator to upgrade to Pro.</p>`}
    <a class="btn" href="#/pricing" style="margin-left:6px">Compare plans</a></div>`);
}
