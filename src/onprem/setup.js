// On-prem first-run setup: creates the data folder, a private PostgreSQL cluster, secrets and config.
// Idempotent — safe to re-run on upgrade (existing config and database are kept; migrations run).
//
// Windows (installer):  AventraITSM.exe setup --data-dir "C:\ProgramData\Aventra ITSM" --pg-bin "C:\Program Files\Aventra ITSM\pgsql\bin" --port 8080
// Other OS (testing):   node src/cli.js setup --data-dir /tmp/itsm --pg-bin /usr/lib/postgresql/16/bin --no-service
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const isWin = process.platform === 'win32';
export const DB_SERVICE = 'AventraITSM-DB';

function run(cmd, args, { allowFail = false, env } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env: { ...process.env, ...env }, windowsHide: true });
  if (r.error) throw new Error(`${path.basename(cmd)}: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) throw new Error(`${path.basename(cmd)} ${args[0] || ''} failed (${r.status}): ${(r.stderr || r.stdout).trim()}`);
  return r;
}

export function readEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const secret = (n) => crypto.randomBytes(n).toString('base64url');

async function waitForPostgres(pgBin, port, tries = 60) {
  const exe = path.join(pgBin, isWin ? 'pg_isready.exe' : 'pg_isready');
  for (let i = 0; i < tries; i++) {
    const r = spawnSync(exe, ['-h', '127.0.0.1', '-p', String(port)], { windowsHide: true });
    if (r.status === 0) return;
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error(`PostgreSQL did not start on port ${port}`);
}

export async function setup(opts, log = console.log) {
  const dataDir = path.resolve(opts.dataDir);
  const pgBin = path.resolve(opts.pgBin);
  const port = parseInt(opts.port || '8080', 10);
  const dbPort = parseInt(opts.dbPort || '5433', 10);
  const useService = isWin && !opts.noService;
  const bin = (name) => path.join(pgBin, isWin ? `${name}.exe` : name);
  if (!fs.existsSync(bin('initdb'))) throw new Error(`PostgreSQL binaries not found in ${pgBin}`);

  const pgData = path.join(dataDir, 'pgdata');
  const logs = path.join(dataDir, 'logs');
  const configFile = path.join(dataDir, 'config.env');
  fs.mkdirSync(logs, { recursive: true });

  // 1. Config + secrets (kept across upgrades)
  const existing = readEnvFile(configFile);
  const dbPassword = existing.ITSM_DB_PASSWORD || secret(24);
  const cfg = {
    NODE_ENV: 'production',
    ITSM_EDITION: 'onprem',
    PORT: existing.PORT || String(port),
    APP_URL: existing.APP_URL || `http://${opts.host || 'localhost'}:${existing.PORT || port}`,
    JWT_SECRET: existing.JWT_SECRET || secret(48),
    ITSM_DB_PASSWORD: dbPassword,
    DATABASE_URL: existing.DATABASE_URL || `postgres://itsm:${encodeURIComponent(dbPassword)}@127.0.0.1:${dbPort}/itsm`,
    ALLOW_SIGNUP: existing.ALLOW_SIGNUP || 'first',
    // On a LAN install served over plain HTTP, Secure cookies would block sign-in. Set to true once behind HTTPS.
    COOKIE_SECURE: existing.COOKIE_SECURE || 'false',
    TRUST_PROXY: existing.TRUST_PROXY || 'false',
  };
  for (const k of ['ANTHROPIC_API_KEY', 'RESEND_API_KEY', 'EMAIL_FROM', 'SLACK_WEBHOOK_URL', 'TEAMS_WEBHOOK_URL']) if (existing[k]) cfg[k] = existing[k];
  const header = '# Aventra ITSM on-prem configuration. Restart the "Aventra ITSM" service after editing.\n'
    + '# Optional: ANTHROPIC_API_KEY, RESEND_API_KEY, EMAIL_FROM, SLACK_WEBHOOK_URL, TEAMS_WEBHOOK_URL\n';
  fs.writeFileSync(configFile, header + Object.entries(cfg).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
  if (isWin) {
    // Only Administrators and SYSTEM may read the secrets file
    run('icacls', [configFile, '/inheritance:r', '/grant:r', '*S-1-5-32-544:F', '*S-1-5-18:F'], { allowFail: true });
  }
  log(`config: ${configFile}`);

  // 2. Database cluster (created once)
  const fresh = !fs.existsSync(path.join(pgData, 'PG_VERSION'));
  if (fresh) {
    const pwFile = path.join(dataDir, `.pw-${process.pid}`);
    fs.writeFileSync(pwFile, dbPassword, { mode: 0o600 });
    try {
      run(bin('initdb'), ['-D', pgData, '-U', 'itsm', '-A', 'scram-sha-256', `--pwfile=${pwFile}`, '-E', 'UTF8', '--locale=C']);
    } finally { fs.rmSync(pwFile, { force: true }); }
    fs.appendFileSync(path.join(pgData, 'postgresql.conf'),
      `\n# Aventra ITSM\nlisten_addresses = 'localhost'\nport = ${dbPort}\nmax_connections = 50\nshared_buffers = 128MB\nlogging_collector = on\nlog_directory = '${path.join(logs, 'postgres').replace(/\\/g, '/')}'\n`);
    log('database cluster created');
  }

  // 3. Start PostgreSQL (Windows service, or a background process elsewhere)
  if (useService) {
    const q = run('sc', ['query', DB_SERVICE], { allowFail: true });
    if (q.status !== 0) {
      run(bin('pg_ctl'), ['register', '-N', DB_SERVICE, '-D', pgData, '-S', 'auto', '-w']);
      // The service runs as NETWORK SERVICE; give it the data folder
      run('icacls', [pgData, '/grant', '*S-1-5-20:(OI)(CI)F', '/T', '/Q']);
      run('icacls', [logs, '/grant', '*S-1-5-20:(OI)(CI)M', '/T', '/Q']);
      run('sc', ['description', DB_SERVICE, 'PostgreSQL database for Aventra ITSM'], { allowFail: true });
      run('sc', ['failure', DB_SERVICE, 'reset=', '86400', 'actions=', 'restart/10000/restart/30000/restart/60000'], { allowFail: true });
    }
    run('net', ['start', DB_SERVICE], { allowFail: true });
  } else {
    const st = run(bin('pg_ctl'), ['status', '-D', pgData], { allowFail: true });
    if (st.status !== 0) run(bin('pg_ctl'), ['start', '-D', pgData, '-w', '-l', path.join(logs, 'postgres.log')]);
  }
  await waitForPostgres(pgBin, dbPort);

  // 4. Application database
  const env = { PGPASSWORD: dbPassword };
  const has = run(bin('psql'), ['-h', '127.0.0.1', '-p', String(dbPort), '-U', 'itsm', '-d', 'postgres', '-tAc', "SELECT 1 FROM pg_database WHERE datname='itsm'"], { env });
  if (!has.stdout.trim()) {
    run(bin('createdb'), ['-h', '127.0.0.1', '-p', String(dbPort), '-U', 'itsm', 'itsm'], { env });
    log('database "itsm" created');
  }

  // 5. Schema
  process.env.DATABASE_URL = cfg.DATABASE_URL;
  const { migrate } = await import('../db/migrate.js');
  const { pool } = await import('../db/index.js');
  await migrate({ log });
  if (opts.demo) { const { seed } = await import('../db/seed.js'); await seed({ log }); }
  await pool.end();
  log(`setup complete — open ${cfg.APP_URL} to create your workspace`);
  return { configFile, appUrl: cfg.APP_URL, fresh };
}

export function stopDatabase(opts) {
  const pgBin = path.resolve(opts.pgBin);
  const pgData = path.join(path.resolve(opts.dataDir), 'pgdata');
  if (isWin && !opts.noService) run('net', ['stop', DB_SERVICE], { allowFail: true });
  else run(path.join(pgBin, isWin ? 'pg_ctl.exe' : 'pg_ctl'), ['stop', '-D', pgData, '-m', 'fast'], { allowFail: true });
}
