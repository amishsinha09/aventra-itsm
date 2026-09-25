import { tx, one, many, q } from '../db/index.js';
import { bad, notFound } from '../lib/http.js';
import { validate, str, int, oneOf, obj } from '../lib/validate.js';
import { staffOnly as staffOnlyBase, adminOnly as adminOnlyBase, audit } from '../lib/auth.js';
import { requireFeature } from '../lib/plans.js';

// Every CMDB endpoint is a Pro feature
const cmdbFeature = requireFeature('cmdb');
const staffOnly = async (req) => { staffOnlyBase(req); await cmdbFeature(req); };
const adminOnly = async (req) => { adminOnlyBase(req); await cmdbFeature(req); };

export const CI_CLASSES = ['server', 'workstation', 'laptop', 'network', 'application', 'database', 'service', 'cloud', 'storage', 'mobile', 'printer'];
export const CI_STATUSES = ['operational', 'degraded', 'down', 'maintenance', 'retired'];
const REL_TYPES = ['depends_on', 'runs_on', 'connects_to', 'hosts', 'backs_up'];

const ciSchema = {
  name: str({ required: true, max: 200 }), ci_class: oneOf(CI_CLASSES, { required: true }), status: oneOf(CI_STATUSES),
  environment: oneOf(['production', 'staging', 'development', 'test', 'dr']), criticality: int({ min: 1, max: 4 }),
  ip_address: str({ max: 64 }), os: str({ max: 120 }), serial_number: str({ max: 120 }),
  company_id: int(), owner_id: int(), support_group_id: int(), attributes: obj(),
};

async function checkRefs(tenantId, b) {
  for (const [col, table] of [['company_id', 'companies'], ['owner_id', 'users'], ['support_group_id', 'groups']]) {
    if (b[col] != null && !(await one(`SELECT 1 FROM ${table} WHERE tenant_id=$1 AND id=$2`, [tenantId, b[col]]))) throw bad(`${col} not found`);
  }
}

export default function (r) {
  r.get('/api/cis', staffOnly, async (req) => {
    const f = req.query; const params = [req.user.tenant_id]; const where = ['c.tenant_id = $1'];
    const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
    if (CI_CLASSES.includes(f.class)) add('c.ci_class = ?', f.class);
    if (CI_STATUSES.includes(f.status)) add('c.status = ?', f.status);
    else if (f.status !== 'all') where.push(`c.status <> 'retired'`);
    if (/^\d+$/.test(f.company || '')) add('c.company_id = ?', +f.company);
    if (f.q) {
      params.push(`%${f.q.slice(0, 100).replace(/[%_\\]/g, '\\$&')}%`);
      const n = params.length;
      where.push(`(c.name ILIKE $${n} OR c.ip_address ILIKE $${n} OR c.serial_number ILIKE $${n})`);
    }
    const limit = Math.min(parseInt(f.limit, 10) || 100, 500);
    return many(`SELECT c.*, co.name AS company_name, g.name AS support_group_name,
        (SELECT count(*)::int FROM tickets t WHERE t.ci_id = c.id AND t.resolved_at IS NULL) AS open_tickets
      FROM cis c LEFT JOIN companies co ON co.id = c.company_id LEFT JOIN groups g ON g.id = c.support_group_id
      WHERE ${where.join(' AND ')} ORDER BY c.criticality, c.name LIMIT ${limit}`, params);
  });

  r.post('/api/cis', staffOnly, async (req, res) => {
    const b = validate(ciSchema, req.body);
    await checkRefs(req.user.tenant_id, b);
    const cols = Object.keys(b);
    const vals = cols.map((k) => (k === 'attributes' ? JSON.stringify(b[k]) : b[k]));
    const ci = await one(`INSERT INTO cis (tenant_id, ${cols.join(',')}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(',')}) RETURNING *`, [req.user.tenant_id, ...vals]);
    await audit(req, 'ci.create', 'ci', ci.id, { name: ci.name });
    res.statusCode = 201;
    return ci;
  });

  r.get('/api/cis/:id', staffOnly, async (req) => {
    const ci = await one(`SELECT c.*, co.name AS company_name, g.name AS support_group_name, o.name AS owner_name
      FROM cis c LEFT JOIN companies co ON co.id=c.company_id LEFT JOIN groups g ON g.id=c.support_group_id LEFT JOIN users o ON o.id=c.owner_id
      WHERE c.tenant_id=$1 AND c.id=$2`, [req.user.tenant_id, +req.params.id || 0]);
    if (!ci) throw notFound('Configuration item not found');
    const relationships = await many(`SELECT r.id, r.rel_type, r.parent_id, r.child_id,
        p.name AS parent_name, p.ci_class AS parent_class, p.status AS parent_status,
        ch.name AS child_name, ch.ci_class AS child_class, ch.status AS child_status
      FROM ci_relationships r JOIN cis p ON p.id=r.parent_id JOIN cis ch ON ch.id=r.child_id
      WHERE r.tenant_id=$1 AND (r.parent_id=$2 OR r.child_id=$2)`, [req.user.tenant_id, ci.id]);
    // Impact analysis: everything that (transitively) depends on this CI. parent depends_on child.
    const impacted = await many(`WITH RECURSIVE up(id, depth) AS (
        SELECT parent_id, 1 FROM ci_relationships WHERE child_id = $2 AND tenant_id = $1
        UNION SELECT r.parent_id, up.depth + 1 FROM ci_relationships r JOIN up ON r.child_id = up.id WHERE up.depth < 6 AND r.tenant_id = $1)
      SELECT c.id, c.name, c.ci_class, c.criticality, c.status, min(up.depth)::int AS depth FROM up JOIN cis c ON c.id = up.id
      WHERE c.id <> $2 GROUP BY c.id ORDER BY depth, c.criticality`, [req.user.tenant_id, ci.id]);
    const tickets = await many(`SELECT id, number, type, title, status, priority, created_at FROM tickets
      WHERE tenant_id=$1 AND ci_id=$2 ORDER BY created_at DESC LIMIT 25`, [req.user.tenant_id, ci.id]);
    return { ci, relationships, impacted, tickets };
  });

  r.patch('/api/cis/:id', staffOnly, async (req) => {
    const b = validate(ciSchema, req.body, { partial: true });
    await checkRefs(req.user.tenant_id, b);
    const cols = Object.keys(b);
    if (!cols.length) throw bad('Nothing to update');
    const vals = cols.map((k) => (k === 'attributes' ? JSON.stringify(b[k]) : b[k]));
    const ci = await one(`UPDATE cis SET ${cols.map((k, i) => `${k}=$${i + 3}`).join(',')}, updated_at=now()
      WHERE tenant_id=$1 AND id=$2 RETURNING *`, [req.user.tenant_id, +req.params.id || 0, ...vals]);
    if (!ci) throw notFound('Configuration item not found');
    await audit(req, 'ci.update', 'ci', ci.id, b);
    return ci;
  });

  r.delete('/api/cis/:id', adminOnly, async (req) => {
    // Soft delete keeps ticket history intact
    const ci = await one(`UPDATE cis SET status='retired', updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING id`, [req.user.tenant_id, +req.params.id || 0]);
    if (!ci) throw notFound();
    await audit(req, 'ci.retire', 'ci', ci.id);
    return { ok: true };
  });

  r.post('/api/cis/:id/relationships', staffOnly, async (req, res) => {
    const b = validate({ child_id: int({ required: true }), rel_type: oneOf(REL_TYPES, { default: 'depends_on' }) }, req.body);
    const parent = +req.params.id || 0;
    if (parent === b.child_id) throw bad('A CI cannot relate to itself');
    const ok = await one('SELECT count(*)::int AS n FROM cis WHERE tenant_id=$1 AND id = ANY($2::int[])', [req.user.tenant_id, [parent, b.child_id]]);
    if (ok.n !== 2) throw notFound('Configuration item not found');
    const rel = await one(`INSERT INTO ci_relationships (tenant_id, parent_id, child_id, rel_type) VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.user.tenant_id, parent, b.child_id, b.rel_type]);
    res.statusCode = 201;
    return rel;
  });

  r.delete('/api/ci-relationships/:id', staffOnly, async (req) => {
    const x = await one('DELETE FROM ci_relationships WHERE tenant_id=$1 AND id=$2 RETURNING id', [req.user.tenant_id, +req.params.id || 0]);
    if (!x) throw notFound();
    return { ok: true };
  });
}

// Upsert discovered devices (used by the Aventra agent inventory feed)
export async function upsertDiscoveredCI(dbc, tenantId, d) {
  let companyId = null;
  if (d.company) {
    const c = await dbc.one(`INSERT INTO companies (tenant_id, name) VALUES ($1,$2) ON CONFLICT (tenant_id, name) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [tenantId, String(d.company).slice(0, 120)]);
    companyId = c.id;
  }
  const cls = CI_CLASSES.includes(d.ci_class) ? d.ci_class : (/server|srv/i.test(d.os || d.hostname) ? 'server' : 'workstation');
  return dbc.one(`INSERT INTO cis (tenant_id, company_id, name, ci_class, ip_address, os, serial_number, attributes, source, last_seen_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'aventra',now())
    ON CONFLICT (tenant_id, name) DO UPDATE SET ip_address = COALESCE(EXCLUDED.ip_address, cis.ip_address), os = COALESCE(EXCLUDED.os, cis.os),
      serial_number = COALESCE(EXCLUDED.serial_number, cis.serial_number), company_id = COALESCE(EXCLUDED.company_id, cis.company_id),
      attributes = cis.attributes || EXCLUDED.attributes, last_seen_at = now(), updated_at = now(),
      status = CASE WHEN cis.status = 'retired' THEN 'operational' ELSE cis.status END
    RETURNING *`, [tenantId, companyId, String(d.hostname).slice(0, 200), cls, d.ip_address || null, d.os || null, d.serial_number || null, JSON.stringify(d.attributes || {})]);
}
