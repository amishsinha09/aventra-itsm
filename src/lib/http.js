// Tiny dependency-free HTTP framework: routing, JSON bodies, cookies, errors, rate limiting.
import { PgError } from '../db/pg.js';

export class HttpError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}
export const bad = (msg, details) => new HttpError(400, msg, details);
export const notFound = (what = 'Not found') => new HttpError(404, what);
export const forbidden = (msg = 'Forbidden') => new HttpError(403, msg);

export class Router {
  constructor() { this.routes = []; }
  // Last argument may be an options object: { public: true } skips authentication.
  add(method, pattern, ...handlers) {
    const opts = typeof handlers[handlers.length - 1] === 'object' ? handlers.pop() : {};
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\/:(\w+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, keys, handlers, opts });
  }
  get(p, ...h) { this.add('GET', p, ...h); }
  post(p, ...h) { this.add('POST', p, ...h); }
  patch(p, ...h) { this.add('PATCH', p, ...h); }
  put(p, ...h) { this.add('PUT', p, ...h); }
  delete(p, ...h) { this.add('DELETE', p, ...h); }
  match(method, path) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = path.match(r.re);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { handlers: r.handlers, params, opts: r.opts };
    }
    return pathMatched ? 'method' : null;
  }
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Fixed-window in-memory rate limiter (per instance). Good enough for a single Railway service;
// swap for a Postgres/Redis-backed limiter when running multiple replicas.
export function rateLimit({ windowMs, max, key = (req) => req.ip }) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, windowMs).unref();
  return (req) => {
    const k = key(req); const now = Date.now();
    let h = hits.get(k);
    if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; hits.set(k, h); }
    h.n++;
    if (h.n > max) throw new HttpError(429, 'Too many requests, please slow down');
  };
}

// Works for both drivers: any error carrying a 5-character SQLSTATE code came from Postgres
export function pgToHttp(e) {
  if (!(e instanceof PgError) && !(typeof e?.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code) && 'severity' in e)) return e;
  if (e.code === '23505') return new HttpError(409, 'A record with that value already exists', { constraint: e.constraint });
  if (e.code === '23503') return new HttpError(400, 'Referenced record does not exist', { constraint: e.constraint });
  if (e.code === '23514' || e.code === '22P02' || e.code === '23502') return new HttpError(400, 'Invalid value', { constraint: e.constraint });
  return e;
}
