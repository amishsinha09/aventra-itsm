import { tx, one, many, q, db } from '../db/index.js';
import { bad, notFound, forbidden } from '../lib/http.js';
import { validate, str, int, oneOf, bool, arr, email, obj } from '../lib/validate.js';
import { staffOnly, adminOnly, audit, hashPassword, passwordProblem, newApiKey } from '../lib/auth.js';
import { CATEGORIES } from '../lib/itsm.js';
import { isTimeZone } from './auth.js';
import { assertSeatAvailable } from '../lib/plans.js';
import { sendInvite } from '../lib/provision.js';

export default function (r) {
  // ---- Users
  r.get('/api/users', staffOnly, async (req) => {
    const params = [req.user.tenant_id]; let extra = '';
    if (['admin', 'agent', 'requester'].includes(req.query.role)) { params.push(req.query.role); extra += ` AND u.role = $${params.length}`; }
    if (req.query.staff === 'true') extra += ` AND u.role IN ('admin','agent')`;
    if (req.query.q) { params.push(`%${req.query.q.slice(0, 100).replace(/[%_\\]/g, '\\$&')}%`); extra += ` AND (u.name ILIKE $${params.length} OR u.email ILIKE $${params.length})`; }
    return many(`SELECT u.id, u.name, u.email, u.role, u.active, u.company_id, c.name AS company_name, u.last_login_at, u.created_at, u.auth_source, u.invited_at, (u.password_hash IS NOT NULL) AS has_password
      FROM users u LEFT JOIN companies c ON c.id = u.company_id WHERE u.tenant_id = $1 ${extra} ORDER BY u.name LIMIT 500`, params);
  });

  r.post('/api/users', adminOnly, async (req, res) => {
    const b = validate({ name: str({ required: true, max: 120 }), email: email({ required: true, max: 200 }), role: oneOf(['admin', 'agent', 'requester'], { required: true }),
      company_id: int(), password: str({ max: 200 }), group_ids: arr(int(), { max: 50 }), invite: bool() }, req.body);
    if (b.password) { const e = passwordProblem(b.password); if (e) throw bad(e); }
    if (b.company_id && !(await one('SELECT 1 FROM companies WHERE tenant_id=$1 AND id=$2', [req.user.tenant_id, b.company_id]))) throw bad('Company not found');
    const hash = b.password ? await hashPassword(b.password) : null;
    const u = await tx(async (d) => {
      if (b.role !== 'requester') await assertSeatAvailable(d, req.user.tenant_id);
      const u = await d.one(`INSERT INTO users (tenant_id, company_id, email, name, role, password_hash) VALUES ($1,$2,$3,$4,$5,$6)
        RETURNING id, name, email, role, company_id, active`, [req.user.tenant_id, b.company_id ?? null, b.email, b.name, b.role, hash]);
      for (const g of b.group_ids || []) {
        if (!(await d.one('SELECT 1 FROM groups WHERE tenant_id=$1 AND id=$2', [req.user.tenant_id, g]))) throw bad('Group not found');
        await d.query('INSERT INTO group_members (group_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [g, u.id]);
      }
      return u;
    });
    await audit(req, 'user.create', 'user', u.id, { email: u.email, role: u.role });
    // Invite by default when no password was set: email a set-password link (or directory sign-in instructions)
    if (b.invite !== false && !b.password) u.invite = await sendInvite(req.user.tenant_id, { ...u, password_hash: null }, req.user.name);
    res.statusCode = 201;
    return u;
  });

  r.patch('/api/users/:id', adminOnly, async (req) => {
    const b = validate({ name: str({ max: 120, min: 1 }), role: oneOf(['admin', 'agent', 'requester']), company_id: int(), active: bool(), password: str({ max: 200 }) }, req.body, { partial: true });
    const id = +req.params.id || 0;
    if (id === req.user.id && (b.role && b.role !== 'admin' || b.active === false)) throw forbidden('You cannot demote or disable yourself');
    if (b.company_id && !(await one('SELECT 1 FROM companies WHERE tenant_id=$1 AND id=$2', [req.user.tenant_id, b.company_id]))) throw bad('Company not found');
    if (b.password) { const e = passwordProblem(b.password); if (e) throw bad(e); b.password_hash = await hashPassword(b.password); delete b.password; }
    if (!Object.keys(b).length) throw bad('Nothing to update');
    const cur = await one('SELECT role, active FROM users WHERE tenant_id=$1 AND id=$2', [req.user.tenant_id, id]);
    if (!cur) throw notFound('User not found');
    // Becoming (or re-activating) a technician needs a free seat
    const willBeStaff = (b.role ?? cur.role) !== 'requester' && (b.active ?? cur.active);
    const wasStaff = cur.role !== 'requester' && cur.active;
    if (willBeStaff && !wasStaff) await assertSeatAvailable(db, req.user.tenant_id, { excludeUserId: id });
    if (b.password_hash || b.active === false || (b.role && b.role !== cur.role)) b.sessions_valid_after = new Date(); // force re-login
    const cols = Object.keys(b);
    const u = await one(`UPDATE users SET ${cols.map((k, i) => `${k}=$${i + 3}`).join(',')}  WHERE tenant_id=$1 AND id=$2
      RETURNING id, name, email, role, company_id, active`, [req.user.tenant_id, id, ...cols.map((k) => b[k])]);
    if (!u) throw notFound('User not found');
    await audit(req, 'user.update', 'user', id, { fields: cols });
    return u;
  });

  // ---- Groups
  r.get('/api/groups', staffOnly, async (req) => many(`SELECT g.*,
      COALESCE((SELECT json_agg(json_build_object('id', u.id, 'name', u.name) ORDER BY u.name) FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = g.id), '[]'::json) AS members
    FROM groups g WHERE g.tenant_id = $1 ORDER BY g.name`, [req.user.tenant_id]));

  const groupSchema = { name: str({ required: true, max: 120 }), description: str({ max: 500 }), categories: arr(oneOf(CATEGORIES), { max: 20 }), is_cab: bool(), member_ids: arr(int(), { max: 200 }) };

  async function setMembers(d, tenantId, groupId, ids) {
    if (!ids) return;
    const valid = await d.many(`SELECT id FROM users WHERE tenant_id=$1 AND id = ANY($2::int[]) AND role IN ('admin','agent')`, [tenantId, ids]);
    if (valid.length !== new Set(ids).size) throw bad('Group members must be agents or admins in this workspace');
    await d.query('DELETE FROM group_members WHERE group_id=$1', [groupId]);
    for (const { id } of valid) await d.query('INSERT INTO group_members (group_id, user_id) VALUES ($1,$2)', [groupId, id]);
  }

  r.post('/api/groups', adminOnly, async (req, res) => {
    const b = validate(groupSchema, req.body);
    const g = await tx(async (d) => {
      const g = await d.one('INSERT INTO groups (tenant_id, name, description, categories, is_cab) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [req.user.tenant_id, b.name, b.description || null, b.categories || [], b.is_cab ?? false]);
      await setMembers(d, req.user.tenant_id, g.id, b.member_ids);
      return g;
    });
    await audit(req, 'group.create', 'group', g.id);
    res.statusCode = 201;
    return g;
  });

  r.patch('/api/groups/:id', adminOnly, async (req) => {
    const b = validate(groupSchema, req.body, { partial: true });
    const id = +req.params.id || 0;
    const g = await tx(async (d) => {
      const { member_ids, ...rest } = b;
      const cols = Object.keys(rest);
      const g = cols.length
        ? await d.one(`UPDATE groups SET ${cols.map((k, i) => `${k}=$${i + 3}`).join(',')} WHERE tenant_id=$1 AND id=$2 RETURNING *`, [req.user.tenant_id, id, ...cols.map((k) => rest[k])])
        : await d.one('SELECT * FROM groups WHERE tenant_id=$1 AND id=$2', [req.user.tenant_id, id]);
      if (!g) throw notFound('Group not found');
      await setMembers(d, req.user.tenant_id, id, member_ids);
      return g;
    });
    await audit(req, 'group.update', 'group', id);
    return g;
  });

  // ---- Companies (MSP customers)
  r.get('/api/companies', staffOnly, async (req) => many(`SELECT c.*,
      (SELECT count(*)::int FROM users u WHERE u.company_id = c.id) AS users,
      (SELECT count(*)::int FROM cis WHERE cis.company_id = c.id AND status <> 'retired') AS cis,
      (SELECT count(*)::int FROM tickets t WHERE t.company_id = c.id AND t.resolved_at IS NULL) AS open_tickets
    FROM companies c WHERE c.tenant_id=$1 ORDER BY c.name`, [req.user.tenant_id]));

  r.post('/api/companies', adminOnly, async (req, res) => {
    const b = validate({ name: str({ required: true, max: 120 }), domain: str({ max: 120 }) }, req.body);
    const c = await one('INSERT INTO companies (tenant_id, name, domain) VALUES ($1,$2,$3) RETURNING *', [req.user.tenant_id, b.name, b.domain || null]);
    await audit(req, 'company.create', 'company', c.id);
    res.statusCode = 201;
    return c;
  });

  r.patch('/api/companies/:id', adminOnly, async (req) => {
    const b = validate({ name: str({ max: 120, min: 1 }), domain: str({ max: 120 }), active: bool() }, req.body, { partial: true });
    const cols = Object.keys(b); if (!cols.length) throw bad('Nothing to update');
    const c = await one(`UPDATE companies SET ${cols.map((k, i) => `${k}=$${i + 3}`).join(',')} WHERE tenant_id=$1 AND id=$2 RETURNING *`, [req.user.tenant_id, +req.params.id || 0, ...cols.map((k) => b[k])]);
    if (!c) throw notFound();
    return c;
  });

  // ---- SLA policies
  r.get('/api/sla-policies', staffOnly, async (req) => many('SELECT * FROM sla_policies WHERE tenant_id=$1 ORDER BY ticket_type, priority', [req.user.tenant_id]));

  r.put('/api/sla-policies', adminOnly, async (req) => {
    const items = validate({ policies: arr(obj(), { required: true, max: 20 }) }, req.body).policies.map((p) => validate({
      ticket_type: oneOf(['incident', 'request'], { required: true }), priority: int({ required: true, min: 1, max: 4 }),
      response_mins: int({ required: true, min: 1, max: 100000 }), resolve_mins: int({ required: true, min: 1, max: 1000000 }) }, p));
    await tx(async (d) => {
      for (const p of items) {
        if (p.resolve_mins < p.response_mins) throw bad('Resolve time must be at least the response time');
        await d.query(`INSERT INTO sla_policies (tenant_id, ticket_type, priority, response_mins, resolve_mins) VALUES ($1,$2,$3,$4,$5)
          ON CONFLICT (tenant_id, ticket_type, priority) DO UPDATE SET response_mins=EXCLUDED.response_mins, resolve_mins=EXCLUDED.resolve_mins`,
        [req.user.tenant_id, p.ticket_type, p.priority, p.response_mins, p.resolve_mins]);
      }
    });
    await audit(req, 'sla.update', 'sla_policies', null, { count: items.length });
    return many('SELECT * FROM sla_policies WHERE tenant_id=$1 ORDER BY ticket_type, priority', [req.user.tenant_id]);
  });

  // ---- API keys for integrations (Aventra agent, email relay, scripts)
  r.get('/api/api-keys', adminOnly, async (req) => many('SELECT id, name, prefix, scopes, last_used_at, revoked_at, created_at FROM api_keys WHERE tenant_id=$1 ORDER BY created_at DESC', [req.user.tenant_id]));

  r.post('/api/api-keys', adminOnly, async (req, res) => {
    const b = validate({ name: str({ required: true, max: 80 }) }, req.body);
    const k = newApiKey();
    const row = await one('INSERT INTO api_keys (tenant_id, name, prefix, key_hash) VALUES ($1,$2,$3,$4) RETURNING id, name, prefix, scopes, created_at', [req.user.tenant_id, b.name, k.prefix, k.hash]);
    await audit(req, 'apikey.create', 'api_key', row.id, { name: b.name });
    res.statusCode = 201;
    return { ...row, key: k.raw, note: 'Copy this key now. It will not be shown again.' };
  });

  r.delete('/api/api-keys/:id', adminOnly, async (req) => {
    const k = await one('UPDATE api_keys SET revoked_at = now() WHERE tenant_id=$1 AND id=$2 AND revoked_at IS NULL RETURNING id', [req.user.tenant_id, +req.params.id || 0]);
    if (!k) throw notFound();
    await audit(req, 'apikey.revoke', 'api_key', k.id);
    return { ok: true };
  });

  // ---- Workspace settings
  r.get('/api/tenant', adminOnly, async (req) => one('SELECT id, name, slug, plan, timezone, created_at FROM tenants WHERE id=$1', [req.user.tenant_id]));
  r.patch('/api/tenant', adminOnly, async (req) => {
    const b = validate({ name: str({ max: 120, min: 2 }), timezone: str({ max: 64 }) }, req.body, { partial: true });
    if (b.timezone && !isTimeZone(b.timezone)) throw bad('Unknown time zone');
    const cols = Object.keys(b); if (!cols.length) throw bad('Nothing to update');
    const t = await one(`UPDATE tenants SET ${cols.map((k, i) => `${k}=$${i + 2}`).join(',')} WHERE id=$1 RETURNING id, name, slug, timezone`, [req.user.tenant_id, ...cols.map((k) => b[k])]);
    await audit(req, 'tenant.update', 'tenant', t.id, b);
    return t;
  });

  r.get('/api/audit', adminOnly, async (req) => many(`SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.tenant_id = $1 ORDER BY a.created_at DESC LIMIT 200`, [req.user.tenant_id]));
}

