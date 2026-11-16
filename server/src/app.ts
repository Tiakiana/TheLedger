import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { systemClock, type Clock } from './clock.js';
import type { Config } from './config.js';
import { Db } from './db.js';
import { AppError } from './errors.js';
import { buildRoutes, SESSION_COOKIE } from './http/routes.js';
import { readJsonBody, parseCookies, Router, SENT, sendJson, type Req } from './http/router.js';
import { serveStatic } from './http/static.js';
import { Hub } from './http/ws.js';
import { Ctx } from './services/context.js';
import { nextDeadline, processDueDonations } from './services/donations.js';
import { ensureGm, userFromToken } from './services/users.js';

export interface App {
  ctx: Ctx;
  server: http.Server | https.Server;
  hub: Hub;
  /** Processes due donation deadlines immediately (also runs automatically). */
  tick(): number;
  listen(port?: number, host?: string): Promise<number>;
  close(): Promise<void>;
  initialGm: { username: string; password: string | null; created: boolean };
}

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

export function createApp(config: Config, opts: { clock?: Clock; schedule?: boolean } = {}): App {
  const db = new Db(config.databasePath);
  const ctx = new Ctx(db, opts.clock ?? systemClock, config);
  const initialGm = ensureGm(ctx);
  let port = config.port;
  const router = buildRoutes(ctx, { get port() { return port; } } as { port: number });

  const allowedHosts = new Set<string>();
  for (const o of [config.publicUrl, ...config.allowedOrigins]) {
    if (!o) continue;
    try {
      allowedHosts.add(new URL(o).host.toLowerCase());
    } catch {
      console.warn(`Ignoring invalid origin "${o}"`);
    }
  }

  /** Browser requests must come from this site (protects cookies against cross-site use). */
  const originAllowed = (req: http.IncomingMessage): boolean => {
    const origin = req.headers.origin;
    if (!origin) return true; // non-browser clients and same-origin GETs
    try {
      const originHost = new URL(origin).host.toLowerCase();
      const host = String(req.headers['x-forwarded-host'] && config.trustProxy ? req.headers['x-forwarded-host'] : req.headers.host ?? '').toLowerCase();
      return originHost === host || allowedHosts.has(originHost);
    } catch {
      return false;
    }
  };

  const clientIp = (req: http.IncomingMessage): string => {
    if (config.trustProxy) {
      const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
      if (fwd) return fwd;
    }
    return req.socket.remoteAddress ?? 'unknown';
  };

  const handler = async (rawReq: http.IncomingMessage, res: http.ServerResponse) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const url = new URL(rawReq.url ?? '/', 'http://localhost');
    const method = rawReq.method ?? 'GET';
    if (!url.pathname.startsWith('/api/')) {
      if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { error: { code: 'method', message: 'Method not allowed.' } });
      return serveStatic(config.publicDir, rawReq, res, url.pathname);
    }
    try {
      const m = router.match(method, url.pathname);
      if (m === null) throw new AppError(404, 'not_found', 'Unknown API endpoint.');
      if (m === 'method') throw new AppError(405, 'method', 'Method not allowed.');
      if (method !== 'GET' && method !== 'HEAD' && !originAllowed(rawReq)) throw new AppError(403, 'bad_origin', 'Request blocked: it did not come from this site.');
      const token = parseCookies(rawReq.headers.cookie)[SESSION_COOKIE];
      const user = userFromToken(ctx, token);
      Router.authorize(m.route, user);
      const body = await readJsonBody(rawReq, 6 * 1024 * 1024);
      const req: Req = { method, path: url.pathname, params: m.params, query: url.searchParams, body, user, token, ip: clientIp(rawReq), raw: rawReq, res };
      const result = await (m.route.handler as (r: Req) => unknown)(req);
      if (result === SENT) return;
      sendJson(res, 200, result);
    } catch (err) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof AppError) return sendJson(res, err.status, { error: { code: err.code, message: err.message, details: err.details } });
      const code = (err as { code?: string }).code;
      if (code === 'ERR_SQLITE_ERROR' && /constraint|immutable|cannot be deleted/i.test(String((err as Error).message))) {
        console.warn('Constraint rejected an operation:', (err as Error).message);
        return sendJson(res, 409, { error: { code: 'conflict', message: 'That change conflicts with the current state. Refresh and try again.' } });
      }
      console.error(err);
      sendJson(res, 500, { error: { code: 'internal', message: 'Something went wrong on the server.' } });
    }
  };

  const server =
    config.tlsCertFile && config.tlsKeyFile
      ? https.createServer({ cert: fs.readFileSync(config.tlsCertFile), key: fs.readFileSync(config.tlsKeyFile) }, handler)
      : http.createServer(handler);
  const hub = new Hub(ctx, originAllowed);
  ctx.sink = hub;
  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    if (pathname === '/ws') hub.handleUpgrade(req, socket, head);
    else socket.destroy();
  });

  const tick = () => {
    try {
      return processDueDonations(ctx);
    } catch (err) {
      console.error('Donation sweep failed', err);
      return 0;
    }
  };

  // Server-authoritative deadlines: resolve anything overdue from before a restart, then keep sweeping.
  tick();
  let timer: NodeJS.Timeout | null = null;
  const schedule = () => {
    const next = nextDeadline(ctx);
    const delay = next === null ? 1000 : Math.min(1000, Math.max(0, next - ctx.now()));
    timer = setTimeout(() => {
      tick();
      schedule();
    }, delay);
  };
  if (opts.schedule !== false) schedule();

  return {
    ctx,
    server,
    hub,
    tick,
    initialGm,
    listen(p = config.port, host = config.host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(p, host, () => {
          port = (server.address() as AddressInfo).port;
          resolve(port);
        });
      });
    },
    async close() {
      if (timer) clearTimeout(timer);
      hub.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
      db.close();
    },
  };
}
