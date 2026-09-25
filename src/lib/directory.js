// Directory sign-in: on-prem Active Directory over LDAP(S), with AD-group → role mapping and
// just-in-time account creation. Settings live in tenants.settings.ldap (secrets encrypted).
import { LdapClient, LdapError, escapeFilter, attr, attrAll, guidToString } from './ldap.js';
import { decryptSecret } from './secrets.js';
import { HttpError } from './http.js';

export const ROLE_RANK = { requester: 1, agent: 2, admin: 3 };

export const DEFAULT_LDAP = {
  enabled: false, url: '', startTls: false, tlsVerify: true, caCert: '',
  baseDN: '', bindDN: '', bindPassword: null,
  userFilter: '(&(objectCategory=person)(objectClass=user)(|(sAMAccountName={username})(userPrincipalName={username})(mail={username})))',
  adminGroups: [], agentGroups: [], requesterGroups: [], defaultRole: 'requester', nestedGroups: true,
};

// AD puts the real reason in the diagnostic text: "... data 52e, ..."
const AD_REASON = {
  '52e': 'Incorrect username or password.', '525': 'Incorrect username or password.',
  '530': 'You are not allowed to sign in at this time (Active Directory logon hours).',
  '531': 'You are not allowed to sign in from this computer (Active Directory workstation restriction).',
  '532': 'Your Windows password has expired. Change it (Ctrl+Alt+Del → Change a password), then sign in again.',
  '533': 'Your account is disabled in Active Directory. Contact your IT administrator.',
  '701': 'Your account has expired in Active Directory. Contact your IT administrator.',
  '773': 'You must change your Windows password before signing in. Sign in to Windows first, then try again.',
  '775': 'Your account is locked out in Active Directory. Wait a few minutes or contact your IT administrator.',
};
export function friendlyLdapError(e) {
  if (e instanceof LdapError && e.code === 49) {
    const m = /data ([0-9a-f]{3})/i.exec(e.diagnostic || '');
    return AD_REASON[m?.[1]?.toLowerCase()] || 'Incorrect username or password.';
  }
  return null;
}

function tlsOptions(cfg) {
  const o = { rejectUnauthorized: cfg.tlsVerify !== false };
  if (cfg.caCert && cfg.caCert.includes('BEGIN CERTIFICATE')) o.ca = [cfg.caCert];
  return o;
}

export async function openDirectory(cfg) {
  const client = new LdapClient({ url: cfg.url, tlsOptions: tlsOptions(cfg) });
  await client.connect();
  try {
    if (cfg.startTls && !client.secure) await client.startTls();
    await client.bind(cfg.bindDN, decryptSecret(cfg.bindPassword));
  } catch (e) { client.close(); throw e; }
  return client;
}

const USER_ATTRS = ['distinguishedName', 'sAMAccountName', 'userPrincipalName', 'mail', 'displayName', 'givenName', 'sn', 'memberOf', 'userAccountControl', 'objectGUID'];

async function resolveGroupDNs(client, cfg, names) {
  const out = [];
  for (const raw of names || []) {
    const n = String(raw).trim();
    if (!n) continue;
    if (/^(cn|ou)=/i.test(n)) { out.push(n); continue; }
    const hits = await client.search({ base: cfg.baseDN, filter: `(&(objectClass=group)(|(cn=${escapeFilter(n)})(sAMAccountName=${escapeFilter(n)})))`, attributes: ['distinguishedName'], sizeLimit: 2 });
    if (hits[0]) out.push(hits[0].dn);
  }
  return out;
}

const sameDN = (a, b) => a.replace(/\s*,\s*/g, ',').toLowerCase() === b.replace(/\s*,\s*/g, ',').toLowerCase();

async function inGroup(client, cfg, user, groupDN) {
  if (attrAll(user, 'memberOf').some((g) => sameDN(g, groupDN))) return true;
  if (!cfg.nestedGroups) return false;
  // AD's LDAP_MATCHING_RULE_IN_CHAIN walks nested group membership server-side
  const hits = await client.search({
    base: cfg.baseDN, filter: `(&(distinguishedName=${escapeFilter(user.dn)})(memberOf:1.2.840.113556.1.4.1941:=${escapeFilter(groupDN)}))`,
    attributes: ['distinguishedName'], sizeLimit: 1,
  });
  return hits.length > 0;
}

// Returns the highest role the user's groups grant, or null if they may not sign in at all.
export async function mapRole(client, cfg, user) {
  for (const [role, key] of [['admin', 'adminGroups'], ['agent', 'agentGroups'], ['requester', 'requesterGroups']]) {
    for (const g of await resolveGroupDNs(client, cfg, cfg[key])) if (await inGroup(client, cfg, user, g)) return role;
  }
  if (cfg.requesterGroups?.length) return null; // requester access is restricted to listed groups
  return cfg.defaultRole === 'none' ? null : 'requester';
}

// Authenticate a user against AD. Returns a profile or throws HttpError(401/403) with a friendly message.
export async function ldapAuthenticate(cfg, username, password) {
  if (!password) throw new HttpError(401, 'Incorrect username or password.');
  let svc;
  try { svc = await openDirectory(cfg); } catch (e) {
    console.error('Directory unavailable:', e.message);
    throw new HttpError(503, 'Can\'t reach Active Directory right now. Try again, or use a local administrator account.');
  }
  try {
    const filter = cfg.userFilter.replaceAll('{username}', escapeFilter(username.trim()));
    const hits = await svc.search({ base: cfg.baseDN, filter, attributes: USER_ATTRS, sizeLimit: 2 });
    if (hits.length !== 1) throw new HttpError(401, 'Incorrect username or password.');
    const user = hits[0];
    const uac = parseInt(attr(user, 'userAccountControl') || '0', 10);
    if (uac & 0x2) throw new HttpError(403, AD_REASON['533']);

    // Verify the password by binding as the user on a separate connection
    const check = new LdapClient({ url: cfg.url, tlsOptions: tlsOptions(cfg) });
    try {
      await check.connect();
      if (cfg.startTls && !check.secure) await check.startTls();
      await check.bind(user.dn, password);
    } catch (e) {
      const msg = friendlyLdapError(e);
      if (msg) throw new HttpError(401, msg);
      throw new HttpError(503, 'Active Directory didn\'t respond. Try again shortly.');
    } finally { check.close(); }

    const role = await mapRole(svc, cfg, user);
    if (!role) throw new HttpError(403, 'Your account isn\'t in a group that has access to the service desk. Ask your IT administrator.');
    const upn = attr(user, 'userPrincipalName');
    const email = (attr(user, 'mail') || upn || `${attr(user, 'sAMAccountName')}@${cfg.baseDN.match(/DC=([^,]+)/gi)?.map((x) => x.slice(3)).join('.') || 'local'}`).toLowerCase();
    const name = attr(user, 'displayName') || [attr(user, 'givenName'), attr(user, 'sn')].filter(Boolean).join(' ') || attr(user, 'sAMAccountName') || email;
    return {
      source: 'ldap',
      externalId: guidToString(user.attributes.objectguid?.[0]) || user.dn.toLowerCase(),
      email, name, role,
      groups: attrAll(user, 'memberOf').map((g) => g.match(/^CN=([^,]+)/i)?.[1] || g).slice(0, 50),
    };
  } finally { svc.close(); }
}

// Admin "Test connection": each step reported separately so problems are easy to pin down.
export async function testDirectory(cfg, { username, password } = {}) {
  const steps = [];
  const step = async (name, fn) => {
    try { const detail = await fn(); steps.push({ name, ok: true, detail }); return true; } catch (e) {
      steps.push({ name, ok: false, detail: (e instanceof HttpError ? e.message : friendlyLdapError(e)) || e.message });
      return false;
    }
  };
  let client;
  const connected = await step(`Connect to ${cfg.url}${cfg.startTls ? ' (StartTLS)' : ''}`, async () => {
    client = new LdapClient({ url: cfg.url, tlsOptions: tlsOptions(cfg) });
    await client.connect();
    if (cfg.startTls && !client.secure) await client.startTls();
    return client.secure ? 'Connected (encrypted)' : 'Connected (unencrypted — use ldaps:// or StartTLS in production)';
  });
  if (!connected) return steps;
  try {
    if (!await step('Sign in with the service account', async () => { await client.bind(cfg.bindDN, decryptSecret(cfg.bindPassword)); return cfg.bindDN; })) return steps;
    await step(`Search ${cfg.baseDN}`, async () => {
      const r = await client.search({ base: cfg.baseDN, scope: 0, filter: '(objectClass=*)', attributes: ['distinguishedName'] });
      if (!r.length) throw new Error('Base DN not found');
      return 'Base DN found';
    });
    for (const [label, key] of [['Admin', 'adminGroups'], ['Technician', 'agentGroups'], ['Requester', 'requesterGroups']]) {
      if (!cfg[key]?.length) continue;
      await step(`Find ${label.toLowerCase()} groups`, async () => {
        const dns = await resolveGroupDNs(client, cfg, cfg[key]);
        if (dns.length !== cfg[key].length) throw new Error(`Found ${dns.length} of ${cfg[key].length}: check the group names`);
        return dns.map((d) => d.match(/^CN=([^,]+)/i)?.[1] || d).join(', ');
      });
    }
  } finally { client.close(); }
  if (username && password) {
    await step(`Sign in as ${username}`, async () => {
      const p = await ldapAuthenticate(cfg, username, password);
      return `${p.name} <${p.email}> → ${p.role}`;
    });
  }
  return steps;
}
