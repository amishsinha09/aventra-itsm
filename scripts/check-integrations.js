// Go-live check: verifies each configured integration with a real call and prints a pass/fail table.
//   npm run check:integrations -- --to you@example.com
// Run it on Railway with: railway run npm run check:integrations -- --to you@example.com
import { config } from '../src/config.js';
import { isMain } from '../src/paths.js';

export async function checkIntegrations(to) {
const results = [];
const record = (name, status, detail) => results.push({ integration: name, status, detail });

// 1. Database + schema
try {
  const { pool, one } = await import('../src/db/index.js');
  const v = await one('SELECT version() AS v, (SELECT count(*)::int FROM schema_migrations) AS migrations');
  record('PostgreSQL', 'PASS', `${await pool.driver()} driver · ${v.v.split(' on ')[0]} · ${v.migrations} migrations applied`);
  await pool.end();
} catch (e) { record('PostgreSQL', 'FAIL', e.message); }

// 2. Session secret
if (config.isProd && config.jwtSecret.length >= 32) record('JWT_SECRET', 'PASS', `${config.jwtSecret.length} characters`);
else if (!config.isProd) record('JWT_SECRET', 'WARN', 'NODE_ENV is not production (dev secret allowed)');

// 3. Claude (AI triage)
if (!config.anthropicKey) record('Claude AI', 'SKIP', 'ANTHROPIC_API_KEY not set — rules-based triage in use');
else {
  try {
    const { triage } = await import('../src/lib/ai.js');
    const r = await triage('VPN down for the whole office', 'Nobody can connect since 9am, error 809.');
    record('Claude AI', r.engine === 'claude' ? 'PASS' : 'FAIL', r.engine === 'claude'
      ? `model ${config.anthropicModel} → ${r.category}, impact ${r.impact}, urgency ${r.urgency}` : 'call failed; fell back to rules (see warning above)');
  } catch (e) { record('Claude AI', 'FAIL', e.message); }
}

// 4. Resend (email)
if (!config.resendKey) record('Resend email', 'SKIP', 'RESEND_API_KEY not set — no outbound email');
else if (!to) record('Resend email', 'SKIP', 'pass --to you@example.com to send a test message');
else {
  try {
    const r = await timed((signal) => fetch('https://api.resend.com/emails', { method: 'POST', signal,
      headers: { authorization: `Bearer ${config.resendKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: config.emailFrom, to: [to], subject: 'Aventra ITSM test email', text: 'Email notifications are working.' }) }));
    const body = await r.text();
    record('Resend email', r.ok ? 'PASS' : 'FAIL', r.ok ? `sent to ${to} from ${config.emailFrom}` : `${r.status}: ${body.slice(0, 200)}`);
  } catch (e) { record('Resend email', 'FAIL', e.message); }
}

// 5. Chat webhooks
for (const [name, url] of [['Slack webhook', config.slackWebhook], ['Teams webhook', config.teamsWebhook]]) {
  if (!url) { record(name, 'SKIP', 'not configured'); continue; }
  try {
    const r = await timed((signal) => fetch(url, { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '✅ Aventra ITSM test alert — chat notifications are working.' }) }));
    record(name, r.ok ? 'PASS' : 'FAIL', r.ok ? 'test message posted' : `${r.status}: ${(await r.text()).slice(0, 200)}`);
  } catch (e) { record(name, 'FAIL', e.message); }
}

// 6. Public URL
try {
  const r = await timed((signal) => fetch(new URL('/api/health', config.appUrl), { signal }));
  record('APP_URL', r.ok ? 'PASS' : 'FAIL', `${config.appUrl} → ${r.status}`);
} catch (e) { record('APP_URL', 'WARN', `${config.appUrl} not reachable from here (${e.message})`); }

console.table(results);
return results;
}

async function timed(fn) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 20000);
  try { return await fn(ctrl.signal); } finally { clearTimeout(t); }
}

export async function runCheck(argv = process.argv) {
  const to = argv.includes('--to') ? argv[argv.indexOf('--to') + 1] : null;
  const results = await checkIntegrations(to);
  process.exit(results.some((r) => r.status === 'FAIL') ? 1 : 0);
}

if (isMain(import.meta.url)) runCheck();
