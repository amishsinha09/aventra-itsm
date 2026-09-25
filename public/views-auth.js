import { html, get, post, formData, fail, modal, toast } from './lib.js';
import { state, refreshMe } from './app.js';

const hero = html`<div class="auth-hero">
  <div class="brand" style="padding:0"><div class="brand-mark">A</div><div>Aventra ITSM</div></div>
  <div>
    <h1>Service management that fixes things before your users notice.</h1>
    <p style="opacity:.85;max-width:460px">Incidents, requests, problems, changes, CMDB and knowledge — connected to Aventra's self-healing agent, so routine issues open, fix and close themselves.</p>
    <ul><li>ITIL-aligned workflows with SLAs and CAB approvals</li><li>Multi-company CMDB with impact analysis</li><li>AI triage, suggested fixes and KB drafting</li><li>Built for MSPs: one workspace, many customers</li></ul>
  </div>
  <div class="small" style="opacity:.6">© Aventra Tech</div>
</div>`;

async function afterAuth() {
  state.me = null; state.meta = null; state.cache = {};
  await refreshMe();
  location.hash = ['admin', 'agent'].includes(state.me.user.role) ? '#/dashboard' : '#/home';
}

export function loginView(app) {
  app.innerHTML = String(html`<div class="auth">${hero}<div class="auth-form"><form class="card" id="f" novalidate>
    <h1>Sign in</h1><p class="muted" style="margin:4px 0 20px">Welcome back to your service desk.</p>
    <div class="field"><label for="email">Work email</label><input id="email" name="email" type="email" autocomplete="username" required></div>
    <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required></div>
    <div class="field hidden" id="wsField"><label for="workspace">Workspace</label><input id="workspace" name="workspace" placeholder="e.g. northwind"></div>
    <button class="btn primary" style="width:100%;justify-content:center" type="submit">Sign in</button>
    <p class="small" style="text-align:center;margin-top:12px"><a href="#/forgot">Forgot password?</a></p>
    <p class="small muted" id="signupHint" style="text-align:center;margin-top:8px">New to Aventra? <a href="#/signup">Create a workspace</a></p>
  </form></div></div>`);
  get('/api/auth/status').then((st) => {
    if (st.needsSetup && st.signupOpen) { location.hash = '#/signup'; return; }
    if (!st.signupOpen) app.querySelector('#signupHint')?.remove();
  }).catch(() => {});
  const f = app.querySelector('#f');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const b = formData(f); if (!b.workspace) delete b.workspace;
    try { await post('/api/auth/login', b); await afterAuth(); } catch (err) {
      if (err.details?.needWorkspace) app.querySelector('#wsField').classList.remove('hidden');
      fail(err);
    }
  });
  app.querySelector('#email').focus();
}

export function signupView(app) {
  app.innerHTML = String(html`<div class="auth">${hero}<div class="auth-form"><form class="card" id="f" novalidate>
    <h1>Create your workspace</h1><p class="muted" style="margin:4px 0 20px">Set up in under a minute. Default SLAs, groups and a service catalog are created for you.</p>
    <div class="field"><label for="organization">Organization</label><input id="organization" name="organization" required></div>
    <div class="field"><label for="name">Your name</label><input id="name" name="name" autocomplete="name" required></div>
    <div class="field"><label for="email">Work email</label><input id="email" name="email" type="email" autocomplete="email" required></div>
    <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="new-password" required><div class="hint">At least 10 characters with letters and numbers.</div></div>
    <button class="btn primary" style="width:100%;justify-content:center" type="submit">Create workspace</button>
    <p class="small muted" style="text-align:center;margin-top:16px">Already have one? <a href="#/login">Sign in</a></p>
  </form></div></div>`);
  const f = app.querySelector('#f');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await post('/api/auth/signup', formData(f)); await afterAuth(); toast('Workspace created'); } catch (err) { fail(err); }
  });
}

export function changePassword() {
  modal({
    title: 'Change password', submit: 'Update password',
    body: html`<div class="field"><label>Current password</label><input type="password" name="current" autocomplete="current-password"></div>
      <div class="field"><label>New password</label><input type="password" name="password" autocomplete="new-password"><div class="hint">At least 10 characters with letters and numbers.</div></div>`,
    onSubmit: async (d) => { await post('/api/auth/password', d); toast('Password updated'); return true; },
  });
}

export function forgotView(app) {
  app.innerHTML = String(html`<div class="auth">${hero}<div class="auth-form"><form class="card" id="f" novalidate>
    <h1>Reset your password</h1><p class="muted" style="margin:4px 0 20px">We'll email you a link to choose a new one.</p>
    <div class="field"><label for="email">Work email</label><input id="email" name="email" type="email" autocomplete="username" required></div>
    <button class="btn primary" style="width:100%;justify-content:center" type="submit">Send reset link</button>
    <p class="small muted" style="text-align:center;margin-top:16px"><a href="#/login">Back to sign in</a></p></form></div></div>`);
  const f = app.querySelector('#f');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { const r = await post('/api/auth/forgot', formData(f)); f.innerHTML = String(html`<h1>Check your email</h1><p class="muted">${r.message}</p><a class="btn" href="#/login">Back to sign in</a>`); } catch (err) { fail(err); }
  });
}

export function resetView(app) {
  const token = new URLSearchParams(location.hash.split('?')[1] || '').get('token') || '';
  app.innerHTML = String(html`<div class="auth">${hero}<div class="auth-form"><form class="card" id="f" novalidate>
    <h1>Choose a new password</h1><p class="muted" style="margin:4px 0 20px">At least 10 characters with letters and numbers.</p>
    <div class="field"><label for="password">New password</label><input id="password" name="password" type="password" autocomplete="new-password" required></div>
    <button class="btn primary" style="width:100%;justify-content:center" type="submit">Set password & sign in</button></form></div></div>`);
  const f = app.querySelector('#f');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await post('/api/auth/reset', { token, password: f.password.value }); toast('Password set'); await afterAuth(); } catch (err) { fail(err); }
  });
}
