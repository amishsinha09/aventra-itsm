// Minimal, dependency-free PostgreSQL client (wire protocol v3).
// Supports: SCRAM-SHA-256 / MD5 / cleartext auth, TLS (sslmode=require),
// parameterized queries (extended protocol), simple multi-statement queries,
// connection pooling and transactions. API mirrors node-postgres:
//   pool.query(sql, params) -> { rows, rowCount }
//   const c = await pool.connect(); await c.query(...); c.release();
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';

const OID = {
  BOOL: 16, INT8: 20, INT2: 21, INT4: 23, OID: 26, JSON: 114, FLOAT4: 700, FLOAT8: 701,
  TIMESTAMP: 1114, TIMESTAMPTZ: 1184, JSONB: 3802, INT4_ARR: 1007, TEXT_ARR: 1009,
  VARCHAR_ARR: 1015, INT8_ARR: 1016, BOOL_ARR: 1000,
};

function parseArray(s, conv = (x) => x) {
  // Parses a 1-D Postgres array literal: {a,"b c",NULL}
  if (s === '{}') return [];
  const out = [];
  let i = 1, cur = '', quoted = false, wasQuoted = false;
  while (i < s.length) {
    const ch = s[i];
    if (quoted) {
      if (ch === '\\') { cur += s[i + 1]; i += 2; continue; }
      if (ch === '"') { quoted = false; i++; continue; }
      cur += ch; i++; continue;
    }
    if (ch === '"') { quoted = true; wasQuoted = true; i++; continue; }
    if (ch === ',' || ch === '}') {
      out.push(!wasQuoted && cur === 'NULL' ? null : conv(cur));
      cur = ''; wasQuoted = false; i++; continue;
    }
    cur += ch; i++;
  }
  return out;
}

function parseValue(text, oid) {
  switch (oid) {
    case OID.BOOL: return text === 't';
    case OID.INT2: case OID.INT4: case OID.OID: return parseInt(text, 10);
    case OID.FLOAT4: case OID.FLOAT8: return parseFloat(text);
    case OID.INT8: return text; // same as node-postgres: bigint -> string
    case OID.JSON: case OID.JSONB: return JSON.parse(text);
    case OID.TIMESTAMPTZ: return new Date(text.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00'));
    case OID.TIMESTAMP: return new Date(text.replace(' ', 'T') + 'Z');
    case OID.TEXT_ARR: case OID.VARCHAR_ARR: return parseArray(text);
    case OID.INT4_ARR: return parseArray(text, (x) => parseInt(x, 10));
    case OID.INT8_ARR: return parseArray(text);
    case OID.BOOL_ARR: return parseArray(text, (x) => x === 't');
    default: return text;
  }
}

function serializeParam(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return v.toString();
  if (Array.isArray(v)) {
    return '{' + v.map((x) => x === null || x === undefined ? 'NULL'
      : '"' + String(x).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"').join(',') + '}';
  }
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

class Writer {
  constructor() { this.parts = []; }
  byte(b) { this.parts.push(Buffer.from([b])); return this; }
  int32(n) { const b = Buffer.alloc(4); b.writeInt32BE(n); this.parts.push(b); return this; }
  int16(n) { const b = Buffer.alloc(2); b.writeInt16BE(n); this.parts.push(b); return this; }
  cstr(s) { this.parts.push(Buffer.from(s + '\0', 'utf8')); return this; }
  bytes(b) { this.parts.push(b); return this; }
  build(type) {
    const body = Buffer.concat(this.parts);
    const len = Buffer.alloc(4); len.writeInt32BE(body.length + 4);
    return type ? Buffer.concat([Buffer.from(type), len, body]) : Buffer.concat([len, body]);
  }
}

export class PgError extends Error {
  constructor(fields) {
    super(fields.M || 'PostgreSQL error');
    this.code = fields.C; this.detail = fields.D; this.severity = fields.S;
    this.constraint = fields.n; this.table = fields.t; this.column = fields.c;
  }
}

export class Client {
  constructor(cfg) {
    this.cfg = cfg;
    this.buf = Buffer.alloc(0);
    this.queue = [];
    this.current = null;
    this.ready = false;
    this.dead = false;
  }

  async connect() {
    const { host, port } = this.cfg;
    let sock = net.connect({ host, port });
    await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
    if (this.cfg.ssl) {
      sock.write(new Writer().int32(80877103).build());
      const resp = await new Promise((res, rej) => { sock.once('data', res); sock.once('error', rej); });
      if (resp[0] !== 0x53) throw new Error('Server does not support SSL');
      sock = tls.connect({ socket: sock, servername: host, rejectUnauthorized: this.cfg.ssl === 'verify' });
      await new Promise((res, rej) => { sock.once('secureConnect', res); sock.once('error', rej); });
    }
    this.sock = sock;
    sock.setNoDelay(true);
    sock.on('data', (d) => this._onData(d));
    sock.on('error', (e) => this._fail(e));
    sock.on('close', () => this._fail(new Error('Connection closed')));

    await new Promise((resolve, reject) => {
      this.current = { startup: true, resolve, reject };
      sock.write(new Writer().int32(196608).cstr('user').cstr(this.cfg.user)
        .cstr('database').cstr(this.cfg.database).cstr('application_name').cstr('aventra-itsm')
        .cstr('client_encoding').cstr('UTF8').byte(0).build());
    });
    this.ready = true;
    return this;
  }

  _fail(err) {
    if (this.dead) return;
    this.dead = true;
    if (this.current) { this.current.reject(err); this.current = null; }
    for (const q of this.queue) q.reject(err);
    this.queue = [];
    if (this.onDead) this.onDead(this);
  }

  _onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 5) {
      const len = this.buf.readInt32BE(1);
      if (this.buf.length < len + 1) break;
      const type = String.fromCharCode(this.buf[0]);
      const body = this.buf.subarray(5, len + 1);
      this.buf = this.buf.subarray(len + 1);
      try { this._handle(type, body); } catch (e) { this._fail(e); }
    }
  }

  _handle(type, body) {
    const q = this.current;
    switch (type) {
      case 'R': return this._auth(body);
      case 'S': case 'K': case 'N': case '1': case '2': case 'n': case 's': return;
      case 'T': { // RowDescription
        const n = body.readInt16BE(0); let off = 2; const fields = [];
        for (let i = 0; i < n; i++) {
          const end = body.indexOf(0, off); const name = body.toString('utf8', off, end); off = end + 1;
          const oid = body.readInt32BE(off + 6); off += 18;
          fields.push({ name, oid });
        }
        if (q) q.fields = fields;
        return;
      }
      case 'D': {
        const n = body.readInt16BE(0); let off = 2; const row = {};
        for (let i = 0; i < n; i++) {
          const l = body.readInt32BE(off); off += 4;
          const f = q.fields[i];
          if (l === -1) row[f.name] = null;
          else { row[f.name] = parseValue(body.toString('utf8', off, off + l), f.oid); off += l; }
        }
        q.rows.push(row);
        return;
      }
      case 'C': {
        const tag = body.toString('utf8', 0, body.length - 1);
        const m = tag.match(/(\d+)$/);
        if (q) q.rowCount = m ? parseInt(m[1], 10) : 0;
        return;
      }
      case 'I': return;
      case 'E': {
        const fields = {}; let off = 0;
        while (body[off] !== 0) {
          const code = String.fromCharCode(body[off]); const end = body.indexOf(0, off + 1);
          fields[code] = body.toString('utf8', off + 1, end); off = end + 1;
        }
        const err = new PgError(fields);
        if (q && q.startup) { this.current = null; q.reject(err); return; }
        if (q) q.error = err;
        return;
      }
      case 'Z': {
        if (!q) return;
        this.current = null;
        if (q.startup) q.resolve();
        else if (q.error) q.reject(q.error);
        else q.resolve({ rows: q.rows, rowCount: q.rowCount ?? q.rows.length, fields: q.fields });
        this._next();
        return;
      }
      default: return;
    }
  }

  _auth(body) {
    const code = body.readInt32BE(0);
    const { user, password = '' } = this.cfg;
    if (code === 0) return; // AuthenticationOk
    if (code === 3) { this.sock.write(new Writer().cstr(password).build('p')); return; }
    if (code === 5) {
      const salt = body.subarray(4, 8);
      const inner = crypto.createHash('md5').update(password + user).digest('hex');
      const outer = crypto.createHash('md5').update(Buffer.concat([Buffer.from(inner), salt])).digest('hex');
      this.sock.write(new Writer().cstr('md5' + outer).build('p')); return;
    }
    if (code === 10) { // SASL
      const mechs = body.toString('utf8', 4).split('\0');
      if (!mechs.includes('SCRAM-SHA-256')) throw new Error('No supported SASL mechanism');
      this.nonce = crypto.randomBytes(18).toString('base64');
      this.clientFirstBare = `n=*,r=${this.nonce}`;
      const data = Buffer.from('n,,' + this.clientFirstBare);
      this.sock.write(new Writer().cstr('SCRAM-SHA-256').int32(data.length).bytes(data).build('p'));
      return;
    }
    if (code === 11) { // SASLContinue
      const serverFirst = body.toString('utf8', 4);
      const attrs = Object.fromEntries(serverFirst.split(',').map((kv) => [kv[0], kv.slice(2)]));
      if (!attrs.r.startsWith(this.nonce)) throw new Error('SCRAM nonce mismatch');
      const salted = crypto.pbkdf2Sync(password.normalize('NFKC'), Buffer.from(attrs.s, 'base64'), parseInt(attrs.i, 10), 32, 'sha256');
      const clientKey = crypto.createHmac('sha256', salted).update('Client Key').digest();
      const storedKey = crypto.createHash('sha256').update(clientKey).digest();
      const finalNoProof = `c=biws,r=${attrs.r}`;
      const authMsg = `${this.clientFirstBare},${serverFirst},${finalNoProof}`;
      const sig = crypto.createHmac('sha256', storedKey).update(authMsg).digest();
      const proof = Buffer.alloc(clientKey.length);
      for (let i = 0; i < proof.length; i++) proof[i] = clientKey[i] ^ sig[i];
      const serverKey = crypto.createHmac('sha256', salted).update('Server Key').digest();
      this.expectedServerSig = crypto.createHmac('sha256', serverKey).update(authMsg).digest('base64');
      this.sock.write(new Writer().bytes(Buffer.from(`${finalNoProof},p=${proof.toString('base64')}`)).build('p'));
      return;
    }
    if (code === 12) { // SASLFinal
      const v = body.toString('utf8', 4).replace(/^v=/, '');
      if (v !== this.expectedServerSig) throw new Error('SCRAM server signature mismatch');
      return;
    }
    throw new Error('Unsupported auth method ' + code);
  }

  query(text, params) {
    if (this.dead) return Promise.reject(new Error('Connection is closed'));
    return new Promise((resolve, reject) => {
      this.queue.push({ text, params, resolve, reject, rows: [], fields: [] });
      if (!this.current) this._next();
    });
  }

  _next() {
    if (this.current || !this.queue.length) return;
    const q = this.current = this.queue.shift();
    if (q.params === undefined) { // simple query protocol (allows multiple statements)
      this.sock.write(new Writer().cstr(q.text).build('Q'));
      return;
    }
    const vals = q.params.map(serializeParam);
    const bind = new Writer().cstr('').cstr('').int16(0).int16(vals.length);
    for (const v of vals) {
      if (v === null) bind.int32(-1);
      else { const b = Buffer.from(v, 'utf8'); bind.int32(b.length).bytes(b); }
    }
    bind.int16(0);
    this.sock.write(Buffer.concat([
      new Writer().cstr('').cstr(q.text).int16(0).build('P'),
      bind.build('B'),
      new Writer().byte(0x50).cstr('').build('D'),
      new Writer().cstr('').int32(0).build('E'),
      new Writer().build('S'),
    ]));
  }

  end() {
    if (this.dead) return;
    try { this.sock.write(new Writer().build('X')); } catch { /* ignore */ }
    this.dead = true; this.sock.end();
  }
}

export function parseUrl(url) {
  const u = new URL(url);
  const sslmode = u.searchParams.get('sslmode') || process.env.PGSSLMODE;
  return {
    host: u.hostname || 'localhost', port: parseInt(u.port || '5432', 10),
    user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.slice(1)),
    ssl: sslmode === 'verify-full' ? 'verify' : (sslmode === 'require' ? true : false),
  };
}

export class Pool {
  constructor({ connectionString, max = 10 }) {
    this.cfg = parseUrl(connectionString);
    this.max = max; this.idle = []; this.total = 0; this.waiters = [];
  }

  async connect() {
    while (this.idle.length) {
      const c = this.idle.pop();
      if (!c.dead) return this._wrap(c);
      this.total--;
    }
    if (this.total < this.max) {
      this.total++;
      try {
        const c = new Client(this.cfg);
        c.onDead = () => { const i = this.idle.indexOf(c); if (i >= 0) { this.idle.splice(i, 1); this.total--; } };
        await c.connect();
        return this._wrap(c);
      } catch (e) { this.total--; throw e; }
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  _wrap(c) {
    let released = false;
    return {
      query: (t, p) => c.query(t, p),
      release: (destroy) => {
        if (released) return; released = true;
        if (destroy || c.dead) { c.end(); this.total--; if (this.waiters.length) this.connect().then(this.waiters.shift()); return; }
        if (this.waiters.length) this.waiters.shift()(this._wrap(c));
        else this.idle.push(c);
      },
    };
  }

  async query(text, params = []) {
    const c = await this.connect();
    try { return await c.query(text, params); } finally { c.release(); }
  }

  async end() { for (const c of this.idle) c.end(); this.idle = []; }
}
