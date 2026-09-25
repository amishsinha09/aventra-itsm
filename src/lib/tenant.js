// Provisioning for a new tenant (workspace): sensible ITIL defaults so it is usable on day one.
import { DEFAULT_SLAS, nextNumber } from './itsm.js';

export async function provisionTenant(db, { name, slug, admin }) {
  const t = await db.one('INSERT INTO tenants (name, slug) VALUES ($1,$2) RETURNING *', [name, slug]);
  const company = await db.one('INSERT INTO companies (tenant_id, name) VALUES ($1,$2) RETURNING *', [t.id, name]);
  const user = await db.one(`INSERT INTO users (tenant_id, company_id, email, name, role, password_hash)
    VALUES ($1,$2,$3,$4,'admin',$5) RETURNING id, tenant_id, company_id, email, name, role`, [t.id, company.id, admin.email, admin.name, admin.password_hash]);

  for (const [type, p, resp, res] of DEFAULT_SLAS) {
    await db.query('INSERT INTO sla_policies (tenant_id, ticket_type, priority, response_mins, resolve_mins) VALUES ($1,$2,$3,$4,$5)', [t.id, type, p, resp, res]);
  }
  const groups = {};
  for (const [gname, desc, cats, cab] of [
    ['Service Desk', 'Level 1 support and triage', ['Access', 'Email', 'Printing', 'Software', 'Other'], false],
    ['Infrastructure', 'Servers, storage, network and cloud', ['Network', 'Hardware', 'Cloud', 'Database'], false],
    ['Security Operations', 'Security incidents and access reviews', ['Security'], false],
    ['Change Advisory Board', 'Approves normal and emergency changes', [], true],
  ]) {
    const g = await db.one('INSERT INTO groups (tenant_id, name, description, categories, is_cab) VALUES ($1,$2,$3,$4,$5) RETURNING id', [t.id, gname, desc, cats, cab]);
    groups[gname] = g.id;
    await db.query('INSERT INTO group_members (group_id, user_id) VALUES ($1,$2)', [g.id, user.id]);
  }
  const items = [
    ['New laptop', 'Request a new or replacement laptop', 'Hardware', true, [
      { name: 'model', label: 'Model', type: 'select', required: true, options: ['Standard 14"', 'Performance 16"', 'MacBook Pro'] },
      { name: 'reason', label: 'Business justification', type: 'textarea', required: true }]],
    ['Software installation', 'Install licensed software on your device', 'Software', false, [
      { name: 'software', label: 'Software name', type: 'text', required: true },
      { name: 'device', label: 'Device / hostname', type: 'text', required: false }]],
    ['Access request', 'Get access to an application, share or system', 'Access', true, [
      { name: 'system', label: 'System or application', type: 'text', required: true },
      { name: 'level', label: 'Access level', type: 'select', required: true, options: ['Read', 'Write', 'Admin'] },
      { name: 'reason', label: 'Reason', type: 'textarea', required: true }]],
    ['New employee onboarding', 'Accounts, device and access for a new hire', 'Access', false, [
      { name: 'employee', label: 'Employee name', type: 'text', required: true },
      { name: 'start_date', label: 'Start date', type: 'date', required: true },
      { name: 'manager', label: 'Manager', type: 'text', required: true }]],
  ];
  for (const [n, d, cat, appr, fields] of items) {
    await db.query(`INSERT INTO catalog_items (tenant_id, name, description, category, fields, approval_required, approver_group_id, fulfillment_group_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [t.id, n, d, cat, JSON.stringify(fields), appr, appr ? groups['Service Desk'] : null,
      cat === 'Hardware' ? groups.Infrastructure : groups['Service Desk']]);
  }
  const num = await nextNumber(db, t.id, 'KB');
  await db.query(`INSERT INTO kb_articles (tenant_id, number, title, body, category, status, author_id) VALUES ($1,$2,$3,$4,$5,'published',$6)`,
    [t.id, num, 'How to reset your password', '## Steps\n1. Go to the sign-in page and choose **Forgot password?**.\n2. Enter your work email and follow the link sent to you.\n3. Choose a new password of at least 10 characters.\n\nStill locked out? Raise an incident in the portal and the Service Desk will help.', 'Access', user.id]);
  return { tenant: t, user, company, groups };
}
