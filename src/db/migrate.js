import fs from 'node:fs';
import path from 'node:path';
import { MIGRATIONS_DIR, isMain } from '../paths.js';
import { pool } from './index.js';

const dir = MIGRATIONS_DIR;

export async function migrate({ log = console.log } = {}) {
  const c = await pool.connect();
  try {
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())', []);
    // Advisory lock so concurrent app instances don't race on startup
    await c.query('SELECT pg_advisory_lock(727274)', []);
    const done = new Set((await c.query('SELECT name FROM schema_migrations', [])).rows.map((r) => r.name));
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      await c.query('BEGIN');
      try {
        await c.query(sql);
        await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
        await c.query('COMMIT');
        log(`migrated ${f}`);
      } catch (e) { await c.query('ROLLBACK'); throw new Error(`Migration ${f} failed: ${e.message}`); }
    }
    await c.query('SELECT pg_advisory_unlock(727274)', []);
  } finally { c.release(); }
}

if (isMain(import.meta.url)) {
  migrate().then(() => pool.end()).then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
