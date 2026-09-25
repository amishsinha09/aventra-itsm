// Demo data: an MSP workspace with customers, agents, CMDB, and tickets across every module.
// Usage: npm run seed   (idempotent: skips if the demo workspace exists)
import { isMain } from '../paths.js';
import { tx, pool, one } from './index.js';
import { migrate } from './migrate.js';
import { hashPassword } from '../lib/auth.js';
import { provisionTenant } from '../lib/tenant.js';
import { createTicket, updateTicket, addComment, decideApproval } from '../lib/tickets.js';
import { nextNumber } from '../lib/itsm.js';

export const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'Demo12345!';

export async function seed({ slug = 'demo', quiet = false } = {}) {
  const log = quiet ? () => {} : console.log;
  await migrate({ log });
  if (await one('SELECT 1 FROM tenants WHERE slug=$1', [slug])) { log('Demo workspace already exists'); return; }
  const pw = await hashPassword(DEMO_PASSWORD);

  await tx(async (d) => {
    const { tenant, user: admin, groups } = await provisionTenant(d, { name: 'Northwind MSP', slug, admin: { email: 'admin@northwind.example', name: 'Amish Sinha', password_hash: pw } });
    // Demo workspace is complimentary so it never locks
    await d.query(`UPDATE tenants SET slug=$2, billing_status='comped', billing_plan='pro', seats=0 WHERE id=$1`, [tenant.id, slug]);
    const T = tenant.id;
    const mkCompany = async (name, domain) => d.one('INSERT INTO companies (tenant_id, name, domain) VALUES ($1,$2,$3) RETURNING *', [T, name, domain]);
    const acme = await mkCompany('Acme Dental Group', 'acmedental.example');
    const contoso = await mkCompany('Contoso Logistics', 'contoso.example');
    const mkUser = async (name, email, role, company) => d.one(`INSERT INTO users (tenant_id, company_id, email, name, role, password_hash)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [T, company?.id ?? null, email, name, role, pw]);
    const priya = await mkUser('Priya Raman', 'priya@northwind.example', 'agent');
    const marcus = await mkUser('Marcus Lee', 'marcus@northwind.example', 'agent');
    const dana = await mkUser('Dana Brooks', 'dana@northwind.example', 'agent');
    const sara = await mkUser('Sara Kim', 'sara@acmedental.example', 'requester', acme);
    const tom = await mkUser('Tom Alvarez', 'tom@contoso.example', 'requester', contoso);
    const member = (g, u) => d.query('INSERT INTO group_members (group_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [g, u.id]);
    await member(groups['Service Desk'], priya); await member(groups['Service Desk'], dana);
    await member(groups.Infrastructure, marcus); await member(groups['Security Operations'], dana);
    await member(groups['Change Advisory Board'], marcus);

    const mkCi = async (name, cls, company, extra = {}) => d.one(`INSERT INTO cis (tenant_id, company_id, name, ci_class, criticality, ip_address, os, support_group_id, environment, source, last_seen_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now()) RETURNING *`, [T, company?.id ?? null, name, cls, extra.crit ?? 3, extra.ip ?? null, extra.os ?? null,
      extra.group ?? groups.Infrastructure, extra.env ?? 'production', extra.source ?? 'manual']);
    const ehr = await mkCi('Acme EHR Application', 'application', acme, { crit: 1 });
    const sql = await mkCi('ACME-SQL01', 'database', acme, { crit: 1, ip: '10.10.1.20', os: 'Windows Server 2022' });
    const vm = await mkCi('ACME-HV01', 'server', acme, { crit: 1, ip: '10.10.1.5', os: 'VMware ESXi 8.0' });
    const fw = await mkCi('ACME-FW01', 'network', acme, { crit: 2, ip: '10.10.0.1', os: 'pfSense 2.7' });
    const wms = await mkCi('Contoso WMS', 'application', contoso, { crit: 1 });
    const web = await mkCi('CTS-WEB02', 'server', contoso, { crit: 2, ip: '172.16.4.12', os: 'Ubuntu 24.04', source: 'aventra' });
    const lap = await mkCi('ACME-LT-0142', 'laptop', acme, { crit: 4, os: 'Windows 11', source: 'aventra', group: groups['Service Desk'] });
    const rel = (p, c, t = 'depends_on') => d.query('INSERT INTO ci_relationships (tenant_id, parent_id, child_id, rel_type) VALUES ($1,$2,$3,$4)', [T, p.id, c.id, t]);
    await rel(ehr, sql); await rel(sql, vm, 'runs_on'); await rel(ehr, fw, 'connects_to'); await rel(wms, web, 'runs_on');

    const A = { kind: 'user', ...admin }; const P = { kind: 'user', ...priya }; const M = { kind: 'user', ...marcus };
    const S = { kind: 'user', ...sara }; const TOM = { kind: 'user', ...tom };
    const bot = { kind: 'apikey', tenant_id: T, name: 'Aventra Agent', role: 'integration' };
    const ago = (h) => new Date(Date.now() - h * 3600000);
    const backdate = (t, h) => d.query(`UPDATE tickets SET created_at=$2, response_due = response_due - ($3 || ' hours')::interval,
      resolve_due = resolve_due - ($3 || ' hours')::interval WHERE id=$1`, [t.id, ago(h), String(h)]);

    // Incidents
    const i1 = await createTicket(d, S, { type: 'incident', title: 'EHR is extremely slow for the whole front desk', description: 'Since this morning every screen in the EHR takes 30+ seconds to load. All users at the Oak Street office are affected and patients are waiting.' });
    await updateTicket(d, A, i1, { ci_id: ehr.id, assignee_id: marcus.id, status: 'in_progress' });
    await addComment(d, M, i1, 'Looking at ACME-SQL01 now — CPU pinned at 100%.', true);
    await addComment(d, M, i1, 'We have identified the cause and are applying a fix. Next update in 30 minutes.', false);
    const i2 = await createTicket(d, TOM, { type: 'incident', title: 'Outlook keeps asking for my password', description: 'Outlook prompts for credentials every few minutes since yesterday.' });
    await backdate(i2, 30);
    const i3 = await createTicket(d, P, { type: 'incident', title: 'Printer on 2nd floor jams on every job', description: 'HP LaserJet near reception jams constantly.', requester_id: sara.id, impact: 3, urgency: 3 });
    let t3 = await d.one('SELECT * FROM tickets WHERE id=$1', [i3.id]);
    t3 = await updateTicket(d, P, t3, { assignee_id: priya.id, status: 'in_progress' });
    await updateTicket(d, P, await d.one('SELECT * FROM tickets WHERE id=$1', [i3.id]), { status: 'resolved', resolution_code: 'solved_permanently', resolution_notes: 'Replaced worn pickup roller and cleaned the paper path. Test prints OK.' });
    const i4 = await createTicket(d, TOM, { type: 'incident', title: 'Cannot connect to VPN from home', description: 'VPN client says "authentication failed" even with correct password.' });
    await updateTicket(d, A, await d.one('SELECT * FROM tickets WHERE id=$1', [i4.id]), { assignee_id: dana.id, status: 'on_hold' });
    await addComment(d, { kind: 'user', ...dana }, i4, 'Can you confirm which VPN client version you have? Waiting on your reply.', false);
    const i5 = await createTicket(d, S, { type: 'incident', title: 'Suspicious email asking to reset Microsoft password', description: 'Got an email that looks like Microsoft asking me to click a link. I did not click it.' });
    await backdate(i5, 80);

    // Aventra self-healing incidents (auto-resolved + escalated)
    for (const [host, title, play, ok, h] of [
      ['ACME-LT-0142', 'Disk space critically low on C:', 'disk-cleanup', true, 50],
      ['CTS-WEB02', 'nginx service stopped', 'restart-service', true, 20],
      ['ACME-LT-0142', 'Windows Update service hung', 'reset-wuauserv', true, 8],
      ['CTS-WEB02', 'Memory usage above 95% for 10 minutes', 'recycle-app-pool', false, 3],
    ]) {
      const ci = host === 'CTS-WEB02' ? web : lap;
      const t = await createTicket(d, bot, { type: 'incident', title: `${title} (${host})`, description: `Aventra detected: ${title}.`, impact: 3, urgency: ok ? 2 : 1,
        ci_id: ci.id, company_id: ci.company_id, source: 'aventra', external_ref: `aventra:demo-${host}-${play}` });
      await backdate(t, h);
      const cur = await d.one('SELECT * FROM tickets WHERE id=$1', [t.id]);
      await addComment(d, bot, cur, `Self-healing started (playbook: ${play}).`, true);
      if (ok) {
        await updateTicket(d, bot, cur, { status: 'resolved', resolution_code: 'auto_remediated', resolution_notes: `Automatically remediated by Aventra using ${play}.` });
        await d.query(`UPDATE tickets SET auto_remediated=true, resolved_at = created_at + interval '4 minutes' WHERE id=$1`, [t.id]);
      } else {
        await addComment(d, bot, cur, 'Self-healing FAILED. Escalating to a technician.', true);
        await updateTicket(d, bot, cur, { status: 'in_progress', group_id: groups.Infrastructure });
      }
    }

    // Problem linked to incidents
    const prb = await createTicket(d, M, { type: 'problem', title: 'Recurring SQL CPU saturation on ACME-SQL01', description: 'Third occurrence this month of EHR slowness caused by SQL CPU saturation.', ci_id: sql.id, impact: 1, urgency: 2 });
    await updateTicket(d, M, await d.one('SELECT * FROM tickets WHERE id=$1', [prb.id]), { status: 'investigating', assignee_id: marcus.id,
      details: { root_cause: 'Missing index on appointments table after vendor upgrade', workaround: 'Restart SQL Agent job EHR_Nightly_Reindex' } });
    await updateTicket(d, M, await d.one('SELECT * FROM tickets WHERE id=$1', [i1.id]), { problem_id: prb.id });

    // Changes
    const start = new Date(Date.now() + 2 * 86400000); start.setUTCHours(3, 0, 0, 0);
    const end = new Date(start.getTime() + 2 * 3600000);
    const chg = await createTicket(d, M, { type: 'change', title: 'Add missing index to EHR appointments table', description: 'Permanent fix for PRB: create covering index during maintenance window.',
      ci_id: sql.id, impact: 2, urgency: 2, details: { change_type: 'normal', planned_start: start.toISOString(), planned_end: end.toISOString(),
        implementation_plan: '1. Snapshot VM\n2. Create index ONLINE\n3. Validate query plans', backout_plan: 'Drop index; revert VM snapshot if needed', test_plan: 'Validated in staging copy' } });
    let c1 = await updateTicket(d, M, await d.one('SELECT * FROM tickets WHERE id=$1', [chg.id]), { status: 'assess' });
    await updateTicket(d, M, await d.one('SELECT * FROM tickets WHERE id=$1', [chg.id]), { status: 'pending_approval' });
    const s2 = new Date(Date.now() + 5 * 86400000); s2.setUTCHours(4, 0, 0, 0);
    const chg2 = await createTicket(d, M, { type: 'change', title: 'Firmware upgrade on ACME-FW01', description: 'Upgrade pfSense to latest patch release.', ci_id: fw.id,
      details: { change_type: 'standard', planned_start: s2.toISOString(), planned_end: new Date(s2.getTime() + 3600000).toISOString(), backout_plan: 'Boot previous boot environment', test_plan: 'Vendor-certified' } });
    await updateTicket(d, M, await d.one('SELECT * FROM tickets WHERE id=$1', [chg2.id]), { status: 'assess' });
    await updateTicket(d, M, await d.one('SELECT * FROM tickets WHERE id=$1', [chg2.id]), { status: 'scheduled' });

    // Requests from the catalog
    const laptop = await d.one(`SELECT * FROM catalog_items WHERE tenant_id=$1 AND name='New laptop'`, [T]);
    const sw = await d.one(`SELECT * FROM catalog_items WHERE tenant_id=$1 AND name='Software installation'`, [T]);
    await createTicket(d, S, { type: 'request', catalog_item_id: laptop.id, description: 'Current laptop is 6 years old.', details: { variables: { model: 'Standard 14"', reason: 'Battery lasts 20 minutes; slows down charting.' } } });
    const r2 = await createTicket(d, TOM, { type: 'request', catalog_item_id: sw.id, details: { variables: { software: 'Visio Professional', device: 'CTS-LT-0077' } } });
    await updateTicket(d, P, await d.one('SELECT * FROM tickets WHERE id=$1', [r2.id]), { status: 'in_progress', assignee_id: priya.id });

    // Knowledge
    for (const [title, body, cat] of [
      ['Fix: Outlook repeatedly prompts for password', '## Symptoms\nOutlook asks for credentials every few minutes.\n\n## Resolution\n1. Close Outlook.\n2. Open **Credential Manager** → Windows Credentials and remove entries starting with `MicrosoftOffice16`.\n3. Reopen Outlook and sign in with modern authentication.\n4. If it persists, run `Get-AuthenticodeSignature` checks via the Microsoft Support and Recovery Assistant.', 'Email'],
      ['VPN "authentication failed" with correct password', '## Cause\nUsually an expired MFA registration or old VPN client.\n\n## Resolution\n1. Confirm the client version is 7.2 or later.\n2. Ask the user to re-register MFA at the self-service portal.\n3. Clear saved credentials in the VPN client and reconnect.', 'Network'],
      ['How to spot and report a phishing email', '## What to look for\n- Urgent requests to reset passwords\n- Sender address that does not match the company\n- Links whose hover address is unfamiliar\n\n## What to do\nDo not click. Use **Report phishing** in Outlook, or raise a Security incident in the portal.', 'Security'],
    ]) {
      const num = await nextNumber(d, T, 'KB');
      await d.query(`INSERT INTO kb_articles (tenant_id, number, title, body, category, status, author_id, views, helpful) VALUES ($1,$2,$3,$4,$5,'published',$6,$7,$8)`,
        [T, num, title, body, cat, priya.id, Math.floor(Math.random() * 120), Math.floor(Math.random() * 30)]);
    }
    // Two weeks of history so dashboards, reports and CSAT have something to show
    let seedN = 7; const rnd = () => ((seedN = (seedN * 16807) % 2147483647) / 2147483647);
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    const hist = [
      ['Laptop will not connect to office Wi-Fi', 'Network'], ['Excel crashes when opening shared workbook', 'Software'], ['New starter needs mailbox', 'Email'],
      ['Monitor flickering on docking station', 'Hardware'], ['Password expired and locked out', 'Access'], ['Teams calls dropping audio', 'Software'],
      ['Shared drive mapping missing after login', 'Network'], ['Scanner not sending to email', 'Printing'], ['MFA prompts not arriving', 'Access'],
    ];
    const good = ['Quick and friendly, thank you!', 'Fixed first time.', 'Great help from the team.', '', ''];
    const meh = ['Took a while to hear back.', 'Had to chase twice.', 'Fixed, but it took a few days.', ''];
    const agents = [P, M, { kind: 'user', ...dana }];
    for (let i = 0; i < 34; i++) {
      const h = 6 + rnd() * 320;
      const req = rnd() < 0.5 ? S : TOM; const auto = rnd() < 0.3;
      const [title, cat] = auto ? [pick(['Disk space low', 'Print spooler stopped', 'Windows Update hung', 'High CPU on service host']), 'Software'] : pick(hist);
      const tk = auto
        ? await createTicket(d, bot, { type: 'incident', title: `${title} (${req === S ? 'ACME' : 'CTS'}-WS-${100 + i})`, impact: 3, urgency: 2, source: 'aventra', company_id: req === S ? acme.id : contoso.id, external_ref: `aventra:hist-${i}` })
        : await createTicket(d, req, { type: 'incident', title, description: 'Reported via portal.' });
      await backdate(tk, h);
      const agent = pick(agents);
      let cur = await d.one('SELECT * FROM tickets WHERE id=$1', [tk.id]);
      if (auto) {
        await updateTicket(d, bot, cur, { status: 'resolved', resolution_code: 'auto_remediated', resolution_notes: 'Automatically remediated by Aventra.' });
        await d.query(`UPDATE tickets SET auto_remediated=true, resolved_at = created_at + interval '3 minutes', category=$2 WHERE id=$1`, [tk.id, cat]);
        continue;
      }
      if (h < 20 && rnd() < 0.5) continue; // leave a few recent ones open
      cur = await updateTicket(d, agent, cur, { assignee_id: agent.id, status: 'in_progress' });
      cur = await d.one('SELECT * FROM tickets WHERE id=$1', [tk.id]);
      await updateTicket(d, agent, cur, { status: 'resolved', resolution_code: 'solved_permanently', resolution_notes: 'Issue fixed and confirmed with the user.' });
      const took = 0.3 + rnd() * (rnd() < 0.2 ? 110 : 10);
      const breached = took > ({ 1: 4, 2: 8, 3: 24, 4: 72 }[cur.priority]);
      await d.query(`UPDATE tickets SET resolved_at = LEAST(created_at + ($2 || ' hours')::interval, now()), responded_at = created_at + interval '12 minutes', sla_breached=$3 WHERE id=$1`, [tk.id, took.toFixed(2), breached]);
      if (rnd() < 0.75) {
        const score = breached ? pick([2, 3, 3, 4]) : pick([4, 5, 5, 5, 4, 3]);
        await d.query(`UPDATE tickets SET csat_score=$2, csat_comment=$3, csat_at = LEAST(resolved_at + interval '2 hours', now()) WHERE id=$1`, [tk.id, score, pick(score >= 4 ? good : meh) || null]);
      }
    }
    log(`Seeded workspace "${tenant.name}" (slug: ${slug}). Sign in as admin@northwind.example / ${DEMO_PASSWORD}`);
  });
}

if (isMain(import.meta.url)) {
  seed().then(() => pool.end()).then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
