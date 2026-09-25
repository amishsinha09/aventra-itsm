import { tx, one, many, q } from '../db/index.js';
import { bad, notFound } from '../lib/http.js';
import { validate, str, int, oneOf, bool, arr, obj } from '../lib/validate.js';
import { isStaff, staffOnly, adminOnly, audit } from '../lib/auth.js';
import { PREFIX, nextNumber } from '../lib/itsm.js';
import { searchTerms } from '../lib/ai.js';

const kbSchema = {
  title: str({ required: true, max: 200 }), body: str({ required: true, max: 100000 }), category: str({ max: 60 }),
  status: oneOf(['draft', 'published', 'retired']), audience: oneOf(['public', 'internal']),
};

const fieldSchema = obj({ maxBytes: 2000 });
const catalogSchema = {
  name: str({ required: true, max: 120 }), description: str({ max: 2000 }), category: str({ max: 60 }),
  fields: arr(fieldSchema, { max: 30 }), approval_required: bool(), approver_group_id: int(), fulfillment_group_id: int(), active: bool(),
};

function checkFields(fields = []) {
  for (const f of fields) {
    if (!f.name || !/^[a-z][a-z0-9_]{0,40}$/.test(f.name)) throw bad('Each field needs a lowercase name (letters, numbers, _)');
    if (!['text', 'textarea', 'select', 'date', 'number', 'checkbox'].includes(f.type)) throw bad(`Unsupported field type ${f.type}`);
    if (f.type === 'select' && (!Array.isArray(f.options) || !f.options.length)) throw bad(`${f.name}: select fields need options`);
  }
}

export default function (r) {
  r.get('/api/kb', async (req) => {
    const staff = isStaff(req.user);
    const params = [req.user.tenant_id]; const where = ['k.tenant_id = $1'];
    if (!staff) where.push(`k.status = 'published' AND k.audience = 'public'`);
    else if (['draft', 'published', 'retired'].includes(req.query.status)) { params.push(req.query.status); where.push(`k.status = $${params.length}`); }
    let rank = 'k.updated_at DESC';
    if (req.query.q) {
      const terms = searchTerms(req.query.q);
      if (terms) {
        params.push(terms);
        where.push(`k.search @@ websearch_to_tsquery('english', $${params.length})`);
        rank = `ts_rank(k.search, websearch_to_tsquery('english', $${params.length})) DESC`;
      }
    }
    if (req.query.category) { params.push(req.query.category); where.push(`k.category = $${params.length}`); }
    return many(`SELECT k.id, k.number, k.title, k.category, k.status, k.audience, k.views, k.helpful, k.not_helpful, k.updated_at,
        left(regexp_replace(k.body, '[#*_>\`\\[\\]]', '', 'g'), 220) AS excerpt, u.name AS author_name
      FROM kb_articles k LEFT JOIN users u ON u.id = k.author_id WHERE ${where.join(' AND ')} ORDER BY ${rank} LIMIT 100`, params);
  });

  r.post('/api/kb', staffOnly, async (req, res) => {
    const b = validate(kbSchema, req.body);
    const a = await tx(async (d) => {
      const number = await nextNumber(d, req.user.tenant_id, PREFIX.kb);
      return d.one(`INSERT INTO kb_articles (tenant_id, number, title, body, category, status, audience, author_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [req.user.tenant_id, number, b.title, b.body, b.category || null, b.status || 'draft', b.audience || 'public', req.user.id]);
    });
    await audit(req, 'kb.create', 'kb', a.id);
    res.statusCode = 201;
    const { search, ...rest } = a; return rest;
  });

  r.get('/api/kb/:id', async (req) => {
    const staff = isStaff(req.user);
    const a = await one(`UPDATE kb_articles k SET views = views + 1 WHERE tenant_id=$1 AND id=$2 ${staff ? '' : `AND status='published' AND audience='public'`}
      RETURNING k.id, k.number, k.title, k.body, k.category, k.status, k.audience, k.views, k.helpful, k.not_helpful, k.created_at, k.updated_at, k.author_id, k.source_ticket_id`,
    [req.user.tenant_id, +req.params.id || 0]);
    if (!a) throw notFound('Article not found');
    const author = a.author_id ? await one('SELECT name FROM users WHERE id=$1', [a.author_id]) : null;
    return { ...a, author_name: author?.name };
  });

  r.patch('/api/kb/:id', staffOnly, async (req) => {
    const b = validate(kbSchema, req.body, { partial: true });
    const cols = Object.keys(b); if (!cols.length) throw bad('Nothing to update');
    const a = await one(`UPDATE kb_articles SET ${cols.map((k, i) => `${k}=$${i + 3}`).join(',')}, updated_at=now()
      WHERE tenant_id=$1 AND id=$2 RETURNING id, number, title, status`, [req.user.tenant_id, +req.params.id || 0, ...cols.map((k) => b[k])]);
    if (!a) throw notFound();
    await audit(req, 'kb.update', 'kb', a.id, { fields: cols });
    return a;
  });

  r.post('/api/kb/:id/feedback', async (req) => {
    const b = validate({ helpful: bool({ required: true }) }, req.body);
    const col = b.helpful ? 'helpful' : 'not_helpful';
    const a = await one(`UPDATE kb_articles SET ${col} = ${col} + 1 WHERE tenant_id=$1 AND id=$2 AND status='published' RETURNING helpful, not_helpful`, [req.user.tenant_id, +req.params.id || 0]);
    if (!a) throw notFound();
    return a;
  });

  // ---- Service catalog
  r.get('/api/catalog', async (req) => many(`SELECT c.*, ag.name AS approver_group_name, fg.name AS fulfillment_group_name
    FROM catalog_items c LEFT JOIN groups ag ON ag.id=c.approver_group_id LEFT JOIN groups fg ON fg.id=c.fulfillment_group_id
    WHERE c.tenant_id=$1 ${req.query.all === 'true' && isStaff(req.user) ? '' : 'AND c.active'} ORDER BY c.category, c.name`, [req.user.tenant_id]));

  r.get('/api/catalog/:id', async (req) => {
    const c = await one(`SELECT * FROM catalog_items WHERE tenant_id=$1 AND id=$2 ${isStaff(req.user) ? '' : 'AND active'}`, [req.user.tenant_id, +req.params.id || 0]);
    if (!c) throw notFound();
    return c;
  });

  r.post('/api/catalog', adminOnly, async (req, res) => {
    const b = validate(catalogSchema, req.body); checkFields(b.fields);
    for (const g of [b.approver_group_id, b.fulfillment_group_id]) if (g && !(await one('SELECT 1 FROM groups WHERE tenant_id=$1 AND id=$2', [req.user.tenant_id, g]))) throw bad('Group not found');
    const c = await one(`INSERT INTO catalog_items (tenant_id, name, description, category, fields, approval_required, approver_group_id, fulfillment_group_id, active)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [req.user.tenant_id, b.name, b.description || null, b.category || 'General', JSON.stringify(b.fields || []),
      b.approval_required ?? false, b.approver_group_id ?? null, b.fulfillment_group_id ?? null, b.active ?? true]);
    await audit(req, 'catalog.create', 'catalog_item', c.id);
    res.statusCode = 201;
    return c;
  });

  r.patch('/api/catalog/:id', adminOnly, async (req) => {
    const b = validate(catalogSchema, req.body, { partial: true });
    if (b.fields) checkFields(b.fields);
    for (const g of [b.approver_group_id, b.fulfillment_group_id]) if (g && !(await one('SELECT 1 FROM groups WHERE tenant_id=$1 AND id=$2', [req.user.tenant_id, g]))) throw bad('Group not found');
    const cols = Object.keys(b); if (!cols.length) throw bad('Nothing to update');
    const c = await one(`UPDATE catalog_items SET ${cols.map((k, i) => `${k}=$${i + 3}`).join(',')} WHERE tenant_id=$1 AND id=$2 RETURNING *`,
      [req.user.tenant_id, +req.params.id || 0, ...cols.map((k) => (k === 'fields' ? JSON.stringify(b[k]) : b[k]))]);
    if (!c) throw notFound();
    await audit(req, 'catalog.update', 'catalog_item', c.id);
    return c;
  });
}
