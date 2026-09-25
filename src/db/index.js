import { Pool as BuiltinPool } from './pg.js';
import { config } from '../config.js';

// Driver selection. Production default is node-postgres (`pg`), the standard, widely audited driver.
// The built-in wire-protocol client is a zero-dependency fallback (used when `pg` isn't installed,
// or forced with DB_DRIVER=builtin). Both expose the same query/connect/release API.
async function createPool() {
  const want = (process.env.DB_DRIVER || 'auto').toLowerCase();
  if (want !== 'builtin') {
    try {
      const pg = (await import('pg')).default;
      const sslmode = process.env.PGSSLMODE;
      const hasSslInUrl = /[?&]sslmode=/.test(config.databaseUrl);
      const ssl = !hasSslInUrl && sslmode && sslmode !== 'disable'
        ? { rejectUnauthorized: sslmode === 'verify-full' } : undefined;
      const p = new pg.Pool({ connectionString: config.databaseUrl, max: config.dbPoolMax, ssl, application_name: 'aventra-itsm' });
      p.on('error', (e) => console.error('Idle Postgres client error:', e.message));
      p.driver = 'pg';
      return p;
    } catch (e) {
      if (want === 'pg') throw new Error(`DB_DRIVER=pg but the pg package could not be loaded: ${e.message}`);
    }
  }
  const p = new BuiltinPool({ connectionString: config.databaseUrl, max: config.dbPoolMax });
  p.driver = 'builtin';
  return p;
}

// Lazily-initialised pool (no top-level await, so the code can be bundled into a single executable)
let ready;
const real = () => (ready ??= createPool().then((p) => {
  if (process.env.NODE_ENV !== 'test') console.log(`database driver: ${p.driver}`);
  return p;
}));
export const pool = {
  query: async (text, params) => (await real()).query(text, params),
  connect: async () => (await real()).connect(),
  end: async () => { if (ready) await (await ready).end(); ready = undefined; },
  driver: async () => (await real()).driver,
};

export const q = (sql, params = []) => pool.query(sql, params);
export const one = async (sql, params = []) => (await pool.query(sql, params)).rows[0] || null;
export const many = async (sql, params = []) => (await pool.query(sql, params)).rows;

// Run fn inside a transaction; fn receives a client with query/one/many helpers.
export async function tx(fn) {
  const c = await pool.connect();
  const client = {
    after: [], // side effects (emails, chat alerts) to run only once the transaction commits
    query: (s, p = []) => c.query(s, p),
    one: async (s, p = []) => (await c.query(s, p)).rows[0] || null,
    many: async (s, p = []) => (await c.query(s, p)).rows,
  };
  try {
    await c.query('BEGIN', []);
    const out = await fn(client);
    await c.query('COMMIT', []);
    for (const f of client.after) Promise.resolve().then(f).catch((e) => console.warn('after-commit task failed:', e.message));
    return out;
  } catch (e) {
    try { await c.query('ROLLBACK', []); } catch { /* connection may be dead */ }
    throw e;
  } finally { c.release(); }
}

// Non-transactional helper with the same shape as a tx client
export const db = { query: q, one, many };
