// Minimal, dependency-free LDAP v3 client (RFC 4511) for Active Directory sign-in.
// Supports: ldap:// and ldaps://, StartTLS, simple bind, search (RFC 4515 filters incl. AD's
// LDAP_MATCHING_RULE_IN_CHAIN extensible match), unbind. Enough to authenticate users and read groups.
import net from 'node:net';
import tls from 'node:tls';

// ---------------------------------------------------------------- BER encoding
function encLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  while (n > 0) { bytes.unshift(n & 0xff); n >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
export function tlv(tag, content) {
  const c = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return Buffer.concat([Buffer.from([tag]), encLen(c.length), c]);
}
function encIntContent(n) {
  if (n === 0) return Buffer.from([0]);
  const bytes = [];
  let v = n;
  while (v > 0) { bytes.unshift(v & 0xff); v = Math.floor(v / 256); }
  if (bytes[0] & 0x80) bytes.unshift(0); // keep it positive
  return Buffer.from(bytes);
}
const int = (n, tag = 0x02) => tlv(tag, encIntContent(n));
const enumerated = (n) => int(n, 0x0a);
const octets = (s, tag = 0x04) => tlv(tag, Buffer.isBuffer(s) ? s : Buffer.from(String(s), 'utf8'));
const bool = (b) => tlv(0x01, Buffer.from([b ? 0xff : 0x00]));
const seq = (...parts) => tlv(0x30, Buffer.concat(parts));

// ---------------------------------------------------------------- BER decoding
export function readTLV(buf, off = 0) {
  if (off + 2 > buf.length) return null;
  const tag = buf[off];
  let len = buf[off + 1]; let p = off + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new Error('Unsupported BER length');
    if (p + n > buf.length) return null;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[p + i];
    p += n;
  }
  if (p + len > buf.length) return null;
  return { tag, start: p, end: p + len, next: p + len, value: buf.subarray(p, p + len) };
}
function children(buf) {
  const out = []; let off = 0;
  while (off < buf.length) { const t = readTLV(buf, off); if (!t) throw new Error('Truncated BER'); out.push(t); off = t.next; }
  return out;
}
const decInt = (b) => { let n = 0; for (const x of b) n = n * 256 + x; return n; };

// ---------------------------------------------------------------- RFC 4515 filter parser → BER
export function escapeFilter(v) {
  return String(v).replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}
function unescapeValue(s) {
  const out = []; const b = Buffer.from(s, 'utf8');
  for (let i = 0; i < b.length; i++) {
    if (b[i] === 0x5c && i + 2 < b.length) { out.push(parseInt(String.fromCharCode(b[i + 1], b[i + 2]), 16)); i += 2; } else out.push(b[i]);
  }
  return Buffer.from(out);
}
export function encodeFilter(str) {
  let i = 0;
  const s = String(str).trim();
  function parse() {
    if (s[i] !== '(') throw new Error(`Invalid LDAP filter near position ${i}`);
    i++;
    let out;
    const c = s[i];
    if (c === '&' || c === '|') {
      i++; const parts = [];
      while (s[i] === '(') parts.push(parse());
      out = tlv(c === '&' ? 0xa0 : 0xa1, Buffer.concat(parts));
    } else if (c === '!') {
      i++; out = tlv(0xa2, parse());
    } else {
      // item: attr op value
      let depth = 0; const st = i;
      while (i < s.length && !(s[i] === ')' && depth === 0)) { if (s[i] === '\\') i += 2; else i++; }
      const item = s.slice(st, i);
      out = encodeItem(item);
    }
    if (s[i] !== ')') throw new Error('Invalid LDAP filter: missing )');
    i++;
    return out;
  }
  const f = parse();
  if (i !== s.length) throw new Error('Invalid LDAP filter: trailing characters');
  return f;
}
function encodeItem(item) {
  let m;
  if ((m = item.match(/^([^:=<>~]*)(?::(dn))?(?::([^:=]+))?:=(.*)$/s)) && item.includes(':=')) {
    // extensible: attr[:dn][:rule]:=value
    const [, attr, dn, rule, value] = m;
    const parts = [];
    if (rule) parts.push(octets(rule, 0x81));
    if (attr) parts.push(octets(attr, 0x82));
    parts.push(octets(unescapeValue(value), 0x83));
    if (dn) parts.push(tlv(0x84, Buffer.from([0xff])));
    return tlv(0xa9, Buffer.concat(parts));
  }
  if ((m = item.match(/^([^=<>~]+)(>=|<=|~=)(.*)$/s))) {
    const tag = { '>=': 0xa5, '<=': 0xa6, '~=': 0xa8 }[m[2]];
    return tlv(tag, Buffer.concat([octets(m[1]), octets(unescapeValue(m[3]))]));
  }
  if ((m = item.match(/^([^=]+)=(.*)$/s))) {
    const [, attr, value] = m;
    if (value === '*') return octets(attr, 0x87); // presence
    if (value.includes('*')) {
      const pieces = value.split('*');
      const subs = [];
      pieces.forEach((p, idx) => {
        if (!p) return;
        const tag = idx === 0 ? 0x80 : idx === pieces.length - 1 ? 0x82 : 0x81;
        subs.push(octets(unescapeValue(p), tag));
      });
      return tlv(0xa4, Buffer.concat([octets(attr), seq(...subs)]));
    }
    return tlv(0xa3, Buffer.concat([octets(attr), octets(unescapeValue(value))]));
  }
  throw new Error(`Invalid LDAP filter item: ${item}`);
}

// ---------------------------------------------------------------- protocol
export const bindRequest = (id, dn, password) =>
  seq(int(id), tlv(0x60, Buffer.concat([int(3), octets(dn), octets(password, 0x80)])));
export const searchRequest = (id, { base, scope = 2, filter, attributes = [], sizeLimit = 0, timeLimit = 10 }) =>
  seq(int(id), tlv(0x63, Buffer.concat([octets(base), enumerated(scope), enumerated(0), int(sizeLimit), int(timeLimit), bool(false),
    encodeFilter(filter), seq(...attributes.map((a) => octets(a)))])));
export const unbindRequest = (id) => seq(int(id), Buffer.from([0x42, 0x00]));
export const startTlsRequest = (id) => seq(int(id), tlv(0x77, octets('1.3.6.1.4.1.1466.20037', 0x80)));

const RESULT_TEXT = { 0: 'success', 1: 'operationsError', 2: 'protocolError', 3: 'timeLimitExceeded', 4: 'sizeLimitExceeded', 7: 'authMethodNotSupported', 8: 'strongerAuthRequired', 10: 'referral', 32: 'noSuchObject', 34: 'invalidDNSyntax', 49: 'invalidCredentials', 50: 'insufficientAccessRights', 51: 'busy', 52: 'unavailable', 53: 'unwillingToPerform' };

export class LdapError extends Error {
  constructor(code, diag) {
    super(`LDAP ${RESULT_TEXT[code] || code}${diag ? `: ${diag}` : ''}`);
    this.code = code; this.diagnostic = diag;
  }
}

function parseResult(content) {
  const [code, matched, diag] = children(content);
  return { code: decInt(code.value), matchedDN: matched.value.toString('utf8'), diagnostic: diag.value.toString('utf8') };
}

export class LdapClient {
  constructor({ url, timeoutMs = 8000, tlsOptions = {} }) {
    const u = new URL(url);
    if (!['ldap:', 'ldaps:'].includes(u.protocol)) throw new Error('Directory URL must start with ldap:// or ldaps://');
    this.secure = u.protocol === 'ldaps:';
    this.host = u.hostname; this.port = parseInt(u.port || (this.secure ? '636' : '389'), 10);
    this.timeoutMs = timeoutMs; this.tlsOptions = tlsOptions;
    this.buf = Buffer.alloc(0); this.pending = new Map(); this.nextId = 1;
  }

  async connect() {
    const onErr = (e) => this._failAll(e);
    this.sock = await new Promise((resolve, reject) => {
      const opts = { host: this.host, port: this.port, servername: net.isIP(this.host) ? undefined : this.host, ...this.tlsOptions };
      const s = this.secure ? tls.connect(opts) : net.connect(opts);
      const t = setTimeout(() => { s.destroy(); reject(new Error(`Timed out connecting to ${this.host}:${this.port}`)); }, this.timeoutMs);
      s.once(this.secure ? 'secureConnect' : 'connect', () => { clearTimeout(t); resolve(s); });
      s.once('error', (e) => { clearTimeout(t); reject(e); });
    });
    this._wire(this.sock, onErr);
    return this;
  }

  _wire(sock, onErr) {
    sock.on('data', (d) => this._onData(d));
    sock.on('error', onErr);
    sock.on('close', () => this._failAll(new Error('Directory connection closed')));
  }

  async startTls() {
    const id = this.nextId++;
    const res = await this._send(id, startTlsRequest(id), 'extended');
    if (res.code !== 0) throw new LdapError(res.code, res.diagnostic);
    this.sock.removeAllListeners('data'); this.sock.removeAllListeners('close'); this.sock.removeAllListeners('error');
    this.sock = await new Promise((resolve, reject) => {
      const s = tls.connect({ socket: this.sock, servername: net.isIP(this.host) ? undefined : this.host, ...this.tlsOptions });
      s.once('secureConnect', () => resolve(s)); s.once('error', reject);
    });
    this.secure = true;
    this._wire(this.sock, (e) => this._failAll(e));
  }

  _failAll(err) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }

  _onData(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    for (;;) {
      let msg;
      try { msg = readTLV(this.buf, 0); } catch (e) { this._failAll(e); this.sock.destroy(); return; }
      if (!msg) return;
      this.buf = this.buf.subarray(msg.next);
      try { this._handle(msg.value); } catch (e) { this._failAll(e); }
    }
  }

  _handle(content) {
    const parts = children(content);
    const id = decInt(parts[0].value);
    const op = parts[1];
    const p = this.pending.get(id);
    if (!p) return; // unsolicited notification (e.g. notice of disconnection) — ignore
    switch (op.tag) {
      case 0x61: case 0x65: case 0x78: { // bind / search done / extended response
        const r = parseResult(op.value);
        clearTimeout(p.timer); this.pending.delete(id);
        p.resolve({ ...r, entries: p.entries });
        return;
      }
      case 0x64: { // search result entry
        const [name, attrs] = children(op.value);
        const entry = { dn: name.value.toString('utf8'), attributes: {} };
        for (const a of children(attrs.value)) {
          const [type, vals] = children(a.value);
          entry.attributes[type.value.toString('utf8').toLowerCase()] = children(vals.value).map((v) => Buffer.from(v.value));
        }
        p.entries.push(entry);
        return;
      }
      case 0x73: return; // search result reference (referral) — AD returns these for other partitions; ignore
      default: return;
    }
  }

  _send(id, packet, kind) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Directory request timed out')); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, kind, entries: [] });
      this.sock.write(packet);
    });
  }

  async bind(dn, password) {
    // An empty password is an "unauthenticated bind" that AD accepts — never treat it as a login
    if (!password) throw new LdapError(49, 'empty password');
    const id = this.nextId++;
    const r = await this._send(id, bindRequest(id, dn, password), 'bind');
    if (r.code !== 0) throw new LdapError(r.code, r.diagnostic);
    return true;
  }

  async search(opts) {
    const id = this.nextId++;
    const r = await this._send(id, searchRequest(id, opts), 'search');
    if (r.code !== 0 && r.code !== 4) throw new LdapError(r.code, r.diagnostic);
    return r.entries;
  }

  close() {
    try { if (this.sock && !this.sock.destroyed) { this.sock.write(unbindRequest(this.nextId++)); this.sock.end(); } } catch { /* ignore */ }
  }
}

// Helpers for Active Directory attribute values
export const attr = (entry, name) => entry.attributes[name.toLowerCase()]?.[0]?.toString('utf8') ?? null;
export const attrAll = (entry, name) => (entry.attributes[name.toLowerCase()] || []).map((b) => b.toString('utf8'));
export function guidToString(buf) {
  if (!buf || buf.length !== 16) return null;
  const h = buf.toString('hex');
  // AD objectGUID is little-endian for the first three groups
  const le = (s) => s.match(/../g).reverse().join('');
  return `${le(h.slice(0, 8))}-${le(h.slice(8, 12))}-${le(h.slice(12, 16))}-${h.slice(16, 20)}-${h.slice(20)}`;
}
