import { fresh, html, raw, get, post, put, on, toast, fail, formData, options } from './lib.js';

const lines = (v) => (v || []).join('\n');
const list = (s) => String(s || '').split(/[\n;]+/).map((x) => x.trim()).filter(Boolean);
const copyBtn = (text) => html`<button type="button" class="btn sm" data-copy="${text}">Copy</button>`;

// Settings → Sign-in & access
export async function accessTab(box) {
  const a = await get('/api/access');
  const L = a.ldap; const E = a.entra;
  box.innerHTML = String(html`
  <div class="card"><div class="card-head"><h2>Share with your team</h2></div>
    <p class="muted small" style="margin-top:-6px">Send everyone this one link. It works from any browser on your network, and from the Aventra Service Desk desktop app.</p>
    <div class="kv" style="grid-template-columns:170px 1fr auto">
      <div>Sign-in link</div><div><code class="big-link">${a.url}</code></div><div>${copyBtn(a.url)}</div>
      <div>Self-service portal</div><div><code>${a.portalUrl}</code></div><div>${copyBtn(a.portalUrl)}</div>
      <div>Desktop app</div><div><a href="${a.desktopDownload}" target="_blank" rel="noopener">aventratech.org → ITSM → Download</a></div><div>${copyBtn(a.desktopDownload)}</div>
    </div>
    <details style="margin-top:12px"><summary class="small"><strong>Use a friendly address</strong> (e.g. servicedesk.yourcompany.local)</summary>
      <form id="urlForm" class="stack" style="margin-top:10px">
        <p class="small muted">1. In your DNS server, create a record (CNAME or A) pointing the name at this server.<br>2. Enter the full address below. It's used in the link above, in emails and for Microsoft sign-in.${a.edition === 'onprem' ? raw('<br>3. For HTTPS, put the server behind IIS/Caddy with your certificate, then set <code>COOKIE_SECURE=true</code> in config.env.') : ''}</p>
        <div class="btn-row"><input name="public_url" value="${a.publicUrlCustom ? a.url : ''}" placeholder="${a.defaultUrl}" style="max-width:420px"><button class="btn primary" type="submit">Save address</button></div>
      </form></details>
  </div>

  <form class="card" id="ldapForm" autocomplete="off">
    <div class="card-head"><h2>Active Directory (on-prem)</h2><label class="check"><input type="checkbox" name="enabled" ${L.enabled ? raw('checked') : ''}> Enabled</label></div>
    <p class="small muted" style="margin-top:-6px">People sign in with their Windows username (or email) and password. Accounts are created on first sign-in; AD groups decide who is an admin, a technician or a requester. Local accounts, like the one you set up the server with, keep working as a backup.</p>
    <div class="grid g2">
      <div class="field"><label>Domain controller address</label><input name="url" value="${L.url}" placeholder="ldaps://dc01.corp.local:636"><div class="hint">Use <code>ldaps://…:636</code>, or <code>ldap://…:389</code> with StartTLS.</div></div>
      <div class="field"><label>Base DN</label><input name="baseDN" value="${L.baseDN}" placeholder="DC=corp,DC=local"></div>
      <div class="field"><label>Service account (DN or UPN)</label><input name="bindDN" value="${L.bindDN}" placeholder="svc-itsm@corp.local"><div class="hint">A normal domain user with read access is enough.</div></div>
      <div class="field"><label>Service account password</label><input type="password" name="bindPassword" autocomplete="new-password" placeholder="${L.hasBindPassword ? '•••••••• saved (leave blank to keep)' : ''}"></div>
    </div>
    <div class="grid g3">
      <div class="field"><label>Admin groups</label><textarea name="adminGroups" rows="2" placeholder="ITSM-Admins">${lines(L.adminGroups)}</textarea></div>
      <div class="field"><label>Technician groups</label><textarea name="agentGroups" rows="2" placeholder="ITSM-Agents">${lines(L.agentGroups)}</textarea></div>
      <div class="field"><label>Requester groups (optional)</label><textarea name="requesterGroups" rows="2" placeholder="Leave empty = everyone in the domain">${lines(L.requesterGroups)}</textarea></div>
    </div>
    <div class="hint" style="margin:-6px 0 12px">One group per line: a name like <code>ITSM-Agents</code> or a full DN. Nested groups count. Only technicians and admins use paid seats.</div>
    <div class="grid g3">
      <div class="field"><label>Everyone else in the domain</label><select name="defaultRole">${options([['requester', 'Can sign in as a requester'], ['none', 'Cannot sign in']], L.defaultRole)}</select></div>
      <div class="field"><label class="check" style="margin-top:26px"><input type="checkbox" name="startTls" ${L.startTls ? raw('checked') : ''}> Use StartTLS (ldap://)</label></div>
      <div class="field"><label class="check" style="margin-top:26px"><input type="checkbox" name="nestedGroups" ${L.nestedGroups ? raw('checked') : ''}> Include nested groups</label></div>
    </div>
    <details><summary class="small"><strong>Advanced</strong>: certificate and user filter</summary>
      <div class="field" style="margin-top:10px"><label class="check"><input type="checkbox" name="tlsVerify" ${L.tlsVerify !== false ? raw('checked') : ''}> Verify the domain controller's certificate (recommended)</label></div>
      <div class="field"><label>Your domain's CA certificate (PEM), if it isn't publicly trusted</label><textarea name="caCert" rows="4" placeholder="-----BEGIN CERTIFICATE-----">${L.caCert || ''}</textarea></div>
      <div class="field"><label>User search filter</label><input name="userFilter" value="${L.userFilter}"><div class="hint"><code>{username}</code> is replaced with what the person types.</div></div>
    </details>
    <div class="divider"></div>
    <div class="grid g3">
      <div class="field"><label>Test as user (optional)</label><input name="testUser" autocomplete="off" placeholder="jdoe"></div>
      <div class="field"><label>Their password</label><input type="password" name="testPassword" autocomplete="new-password"></div>
      <div class="field"><label>&nbsp;</label><div class="btn-row"><button type="button" class="btn" data-act="test-ldap">Test connection</button><button class="btn primary" type="submit">Save</button></div></div>
    </div>
    <div id="ldapResult"></div>
  </form>

  <form class="card" id="entraForm" autocomplete="off">
    <div class="card-head"><h2>Microsoft Entra ID / Microsoft 365</h2><label class="check"><input type="checkbox" name="enabled" ${E.enabled ? raw('checked') : ''}> Enabled</label></div>
    <p class="small muted" style="margin-top:-6px">Adds a <strong>Sign in with Microsoft</strong> button. Best when your accounts live in Microsoft 365 or are synced there from AD.</p>
    <details ${E.enabled ? '' : raw('open')}><summary class="small"><strong>Set up in the Entra admin center (5 minutes)</strong></summary>
      <ol class="small muted" style="margin:8px 0 12px 18px;display:grid;gap:4px">
        <li>Go to <strong>entra.microsoft.com → App registrations → New registration</strong>. Name it "Aventra ITSM" and choose <em>Accounts in this organizational directory only</em>.</li>
        <li>Under <strong>Redirect URI</strong>, pick <em>Web</em> and paste <code>${a.entraRedirectUri}</code> ${copyBtn(a.entraRedirectUri)}</li>
        <li>Copy the <strong>Application (client) ID</strong> and <strong>Directory (tenant) ID</strong> into the fields below.</li>
        <li><strong>Certificates &amp; secrets → New client secret</strong>, then paste its <em>Value</em> below.</li>
        <li>Roles: either <strong>Token configuration → Add groups claim</strong> (use group Object IDs below), or <strong>App roles</strong> such as <code>ITSM.Admin</code> / <code>ITSM.Agent</code> assigned under Enterprise applications (use the role values below).</li>
      </ol></details>
    <div class="grid g3">
      <div class="field"><label>Directory (tenant) ID</label><input name="tenantId" value="${E.tenantId}" placeholder="00000000-0000-0000-0000-000000000000"></div>
      <div class="field"><label>Application (client) ID</label><input name="clientId" value="${E.clientId}"></div>
      <div class="field"><label>Client secret</label><input type="password" name="clientSecret" autocomplete="new-password" placeholder="${E.hasClientSecret ? '•••••••• saved (leave blank to keep)' : ''}"></div>
    </div>
    <div class="grid g3">
      <div class="field"><label>Admin groups / app roles</label><textarea name="adminGroups" rows="2" placeholder="ITSM.Admin or a group Object ID">${lines(E.adminGroups)}</textarea></div>
      <div class="field"><label>Technician groups / app roles</label><textarea name="agentGroups" rows="2" placeholder="ITSM.Agent">${lines(E.agentGroups)}</textarea></div>
      <div class="field"><label>Requester groups (optional)</label><textarea name="requesterGroups" rows="2" placeholder="Leave empty = anyone in your tenant">${lines(E.requesterGroups)}</textarea></div>
    </div>
    <div class="grid g3"><div class="field"><label>Everyone else in your tenant</label><select name="defaultRole">${options([['requester', 'Can sign in as a requester'], ['none', 'Cannot sign in']], E.defaultRole)}</select></div></div>
    <div class="btn-row"><button class="btn primary" type="submit">Save</button>${E.enabled ? html`<a class="btn" href="/api/auth/sso/microsoft/start" target="_blank" rel="noopener">Try it in a new tab</a>` : ''}</div>
  </form>`);

  const reload = () => accessTab(fresh(box));
  on(box, 'click', '[data-copy]', async (b) => {
    try { await navigator.clipboard.writeText(b.dataset.copy); toast('Copied'); } catch { prompt('Copy this:', b.dataset.copy); }
  });
  box.querySelector('#urlForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await put('/api/access/url', formData(e.target)); toast('Address saved'); reload(); } catch (err) { fail(err); }
  });

  const ldapBody = (form) => {
    const d = formData(form);
    const body = { enabled: d.enabled, url: d.url, baseDN: d.baseDN, bindDN: d.bindDN, startTls: d.startTls, nestedGroups: d.nestedGroups, tlsVerify: d.tlsVerify,
      caCert: d.caCert, userFilter: d.userFilter, defaultRole: d.defaultRole,
      adminGroups: list(d.adminGroups), agentGroups: list(d.agentGroups), requesterGroups: list(d.requesterGroups) };
    if (d.bindPassword) body.bindPassword = d.bindPassword;
    return { body, test: { testUser: d.testUser, testPassword: d.testPassword } };
  };
  const ldapForm = box.querySelector('#ldapForm');
  ldapForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await put('/api/access/ldap', ldapBody(ldapForm).body); toast('Active Directory settings saved'); reload(); } catch (err) { fail(err); }
  });
  on(box, 'click', '[data-act=test-ldap]', async (b) => {
    const { body, test } = ldapBody(ldapForm);
    b.disabled = true; b.textContent = 'Testing…';
    const out = box.querySelector('#ldapResult');
    try {
      const r = await post('/api/access/ldap/test', { ...body, ...test });
      out.innerHTML = String(html`<div class="notice ${r.ok ? 'ok' : 'bad'}" style="margin-top:12px"><strong>${r.ok ? 'Everything works.' : 'Something needs attention.'}</strong>
        <ul class="steps-list">${r.steps.map((s) => html`<li class="${s.ok ? 'ok' : 'bad'}"><span>${s.ok ? '✓' : '✕'}</span> <strong>${s.name}</strong> <span class="muted">${s.detail || ''}</span></li>`)}</ul></div>`);
    } catch (err) { fail(err); } finally { b.disabled = false; b.textContent = 'Test connection'; }
  });

  const entraForm = box.querySelector('#entraForm');
  entraForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(entraForm);
    const body = { enabled: d.enabled, tenantId: d.tenantId, clientId: d.clientId, defaultRole: d.defaultRole,
      adminGroups: list(d.adminGroups), agentGroups: list(d.agentGroups), requesterGroups: list(d.requesterGroups) };
    if (d.clientSecret) body.clientSecret = d.clientSecret;
    try { await put('/api/access/entra', body); toast('Microsoft sign-in settings saved'); reload(); } catch (err) { fail(err); }
  });
}
