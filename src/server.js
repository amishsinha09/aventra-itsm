import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { config } from './config.js';
import { PUBLIC_DIR, isMain } from './paths.js';
import { pool, one } from './db/index.js';
import { migrate } from './db/migrate.js';
import { Router, HttpError, parseCookies, readBody, rateLimit, pgToHttp } from './lib/http.js';
import { authenticate } from './lib/auth.js';
import { startSlaJob } from './lib/slaJob.js';
import authRoutes from './routes/auth.js';
import ticketRoutes from './routes/tickets.js';
import cmdbRoutes from './routes/cmdb.js';
import kbRoutes from './routes/kb.js';
import adminRoutes from './routes/admin.js';
import integrationRoutes from './routes/integrations.js';
import dashboardRoutes from './routes/dashboard.js';
import billingRoutes from './routes/billing.js';
import ssoRoutes from './routes/sso.js';
import { billingFor } from './lib/plans.js';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  ...(config.cookieSecure ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
};

export function buildApp() {
  const router = new Router();
  router.get('/api/health', async () => {
    await one('SELECT 1 AS ok');
    return { ok: true, version: process.env.npm_package_version || '1.0.0' };
  }, { public: true });
  for (const register of [authRoutes, ticketRoutes, cmdbRoutes, kbRoutes, adminRoutes, integrationRoutes, dashboardRoutes, billingRoutes, ssoRoutes]) register(router);

  const apiLimit = rateLimit({ windowMs: 60_000, max: 600, key: (req) => req.user?.id ? `u:${req.user.id}` : `ip:${req.ip}` });
  const integrationLimit = rateLimit({ windowMs: 60_000, max: 1200, key: (req) => `k:${req.user?.keyId}` });

  function send(req, res, status, body, headers = {}) {
    const isRaw = body && typeof body === 'object' && '__raw' in body;
    let payload = isRaw ? body.__raw : JSON.stringify(body ?? null);
    const h = { ...SECURITY_HEADERS, 'Cache-Control': 'no-store', ...headers };
    if (!isRaw) h['Content-Type'] = 'application/json; charset=utf-8';
    if (payload.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      payload = zlib.gzipSync(payload); h['Content-Encoding'] = 'gzip'; h.Vary = 'Accept-Encoding';
    }
    for (const [k, v] of Object.entries(h)) if (!res.hasHeader(k)) res.setHeader(k, v);
    res.statusCode = status;
    res.end(payload);
  }

  const staticCache = new Map();
  function serveStatic(req, res, urlPath) {
    let rel = decodeURIComponent(urlPath);
    if (rel === '/' || !path.extname(rel)) rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR)) return send(req, res, 404, { error: 'Not found' });
    let entry = staticCache.get(file);
    if (!entry || !config.isProd) {
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(req, res, 404, { error: 'Not found' });
      const data = fs.readFileSync(file);
      entry = { data, gz: zlib.gzipSync(data), etag: '"' + crypto.createHash('sha1').update(data).digest('hex').slice(0, 16) + '"' };
      staticCache.set(file, entry);
    }
    const headers = { ...SECURITY_HEADERS, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', ETag: entry.etag,
      'Cache-Control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=300', Vary: 'Accept-Encoding' };
    if (req.headers['if-none-match'] === entry.etag) { res.writeHead(304, headers); return res.end(); }
    const gzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    if (gzip) headers['Content-Encoding'] = 'gzip';
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : gzip ? entry.gz : entry.data);
  }

  return async function handler(req, res) {
    const started = Date.now();
    const url = new URL(req.url, 'http://x');
    req.query = Object.fromEntries(url.searchParams);
    req.cookies = parseCookies(req.headers.cookie);
    req.ip = (config.trustProxy && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress;

    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 405, { error: 'Method not allowed' });
      return serveStatic(req, res, url.pathname);
    }
    try {
      const m = router.match(req.method, url.pathname);
      if (!m) throw new HttpError(404, 'Not found');
      if (m === 'method') throw new HttpError(405, 'Method not allowed');
      req.params = m.params;
      if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) {
        const raw = await readBody(req, url.pathname.includes('/integrations/') ? 5_000_000 : 1_000_000);
        req.rawBody = raw; // Stripe webhook signatures are computed over the exact bytes
        if (raw) {
          if (!/application\/json/.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Content-Type must be application/json');
          try { req.body = JSON.parse(raw); } catch { throw new HttpError(400, 'Invalid JSON'); }
        } else req.body = {};
      }
      if (!m.opts.public) {
        req.user = await authenticate(req);
        if (req.user.kind === 'apikey') {
          integrationLimit(req);
          if (!url.pathname.startsWith('/api/integrations/')) throw new HttpError(403, 'API keys can only call integration endpoints');
        } else apiLimit(req);
        // Expired trial / ended subscription: everything stays readable, changes are blocked (except billing & sign-in)
        if (config.billingMode !== 'off' && req.method !== 'GET' && !/^\/api\/(auth|billing|license|notifications)\b/.test(url.pathname)) {
          const b = await billingFor(req.user.tenant_id);
          if (b.readOnly) throw new HttpError(402, b.message || 'Subscription required', { code: 'subscription_required' });
        }
      }
      let out;
      for (const h of m.handlers) out = await h(req, res);
      send(req, res, res.statusCode && res.statusCode !== 200 ? res.statusCode : 200, out);
    } catch (err) {
      const e = pgToHttp(err);
      const status = e instanceof HttpError ? e.status : 500;
      if (status >= 500) console.error(`[${req.method} ${url.pathname}]`, err);
      send(req, res, status, { error: status >= 500 && config.isProd ? 'Something went wrong' : e.message, details: e.details });
    } finally {
      if (config.isProd && process.env.LOG_REQUESTS !== 'false') {
        console.log(JSON.stringify({ t: new Date().toISOString(), m: req.method, p: url.pathname, s: res.statusCode, ms: Date.now() - started, u: req.user?.id ?? null }));
      }
    }
  };
}

export async function start() {
  await migrate({ log: (m) => console.log(m) });
  const server = http.createServer(buildApp());
  server.headersTimeout = 20_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 65_000;
  await new Promise((r) => server.listen(config.port, r));
  console.log(`Aventra ITSM listening on :${config.port}`);
  startSlaJob(config.slaIntervalSec);
  const shutdown = (sig) => {
    console.log(`${sig} received, shutting down`);
    server.close(() => pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return server;
}

if (isMain(import.meta.url)) {
  start().catch((e) => { console.error('Failed to start:', e); process.exit(1); });
}
