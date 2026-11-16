import type { IncomingMessage, ServerResponse } from 'node:http';
import { AppError, badRequest, forbidden, unauthorized } from '../errors.js';
import type { SessionUser } from '../shared/types.js';

export type Access = 'public' | 'user' | 'player' | 'gm';

export interface Req {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: Record<string, unknown>;
  user: SessionUser | null;
  token: string | undefined;
  ip: string;
  raw: IncomingMessage;
  res: ServerResponse;
}

/** Returned by handlers that wrote the response themselves. */
export const SENT = Symbol('sent');

type Handler = (req: Req & { user: SessionUser }) => unknown;
type PublicHandler = (req: Req) => unknown;

interface Route {
  method: string;
  parts: string[];
  access: Access;
  handler: Handler | PublicHandler;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, access: 'public', handler: PublicHandler): void;
  add(method: string, pattern: string, access: Exclude<Access, 'public'>, handler: Handler): void;
  add(method: string, pattern: string, access: Access, handler: Handler | PublicHandler): void {
    this.routes.push({ method, parts: pattern.split('/').filter(Boolean), access, handler });
  }

  match(method: string, path: string): { route: Route; params: Record<string, string> } | 'method' | null {
    const parts = path.split('/').filter(Boolean);
    let methodMismatch = false;
    for (const route of this.routes) {
      if (route.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const p = route.parts[i];
        if (p.startsWith(':')) {
          try {
            params[p.slice(1)] = decodeURIComponent(parts[i]);
          } catch {
            ok = false;
            break;
          }
        } else if (p !== parts[i]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (route.method !== method) {
        methodMismatch = true;
        continue;
      }
      return { route, params };
    }
    return methodMismatch ? 'method' : null;
  }

  static authorize(route: Route, user: SessionUser | null): void {
    if (route.access === 'public') return;
    if (!user) throw unauthorized();
    if (route.access === 'gm' && !user.isGm) throw forbidden('Only the GM can do that.');
    if (route.access === 'player' && user.isGm) throw forbidden('This is a player action.');
  }
}

export async function readJsonBody(req: IncomingMessage, limitBytes: number): Promise<Record<string, unknown>> {
  const method = req.method ?? 'GET';
  if (method === 'GET' || method === 'HEAD') return {};
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limitBytes) throw new AppError(413, 'too_large', 'The request is too large.');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  const type = req.headers['content-type'] ?? '';
  // Requiring JSON blocks cross-site HTML form posts (they cannot send this content type without a CORS preflight).
  if (!/^application\/json\b/i.test(type)) throw badRequest('Requests must be sent as JSON.');
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw badRequest('The request body is not valid JSON.');
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const val = part.slice(i + 1).trim();
    try {
      out[k] = decodeURIComponent(val);
    } catch {
      out[k] = val;
    }
  }
  return out;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body ?? { ok: true });
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}
