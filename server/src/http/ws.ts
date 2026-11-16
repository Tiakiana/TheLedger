import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import type { Ctx, EventSink } from '../services/context.js';
import { sessionUser, userFromToken } from '../services/users.js';
import type { ServerMessage } from '../shared/types.js';
import { parseCookies } from './router.js';
import { SESSION_COOKIE } from './routes.js';

interface Client {
  ws: WebSocket;
  userId: string;
  isGm: boolean;
  roleId: string | null;
  alive: boolean;
}

/**
 * Pushes change notifications to connected browsers. Messages only tell clients *what*
 * changed; clients then refetch the authoritative state over HTTP, so the UI always
 * reflects the server.
 */
export class Hub implements EventSink {
  private wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  private clients = new Set<Client>();
  private heartbeat: NodeJS.Timeout;

  constructor(
    private ctx: Ctx,
    private originAllowed: (req: IncomingMessage) => boolean,
  ) {
    this.heartbeat = setInterval(() => {
      for (const c of this.clients) {
        if (!c.alive) {
          c.ws.terminate();
          continue;
        }
        c.alive = false;
        try {
          c.ws.ping();
        } catch {
          /* ignore */
        }
      }
    }, 25_000);
    this.heartbeat.unref();
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const reject = (code: number, text: string) => {
      socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (!this.originAllowed(req)) return reject(403, 'Forbidden');
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const user = userFromToken(this.ctx, token);
    if (!user) return reject(401, 'Unauthorized');
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const client: Client = { ws, userId: user.id, isGm: user.isGm, roleId: user.roleId, alive: true };
      this.clients.add(client);
      ws.on('pong', () => (client.alive = true));
      ws.on('message', () => (client.alive = true)); // clients may send keep-alives; content is ignored
      ws.on('close', () => this.clients.delete(client));
      ws.on('error', () => this.clients.delete(client));
      this.send(client, { type: 'hello', userId: user.id });
    });
  }

  private send(c: Client, msg: ServerMessage): void {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
  }

  changed(roles: string[], opts: { gm: boolean; catalog?: boolean }): void {
    const msg: ServerMessage = { type: 'changed', roles, gm: opts.gm, catalog: opts.catalog };
    for (const c of this.clients) {
      if (opts.catalog || (c.isGm && opts.gm) || (c.roleId !== null && roles.includes(c.roleId))) this.send(c, msg);
    }
  }

  notifyRole(roleId: string, message: ServerMessage): void {
    for (const c of this.clients) if (c.roleId === roleId) this.send(c, message);
  }

  userChanged(userId: string): void {
    for (const c of this.clients) {
      if (c.userId !== userId) continue;
      const u = sessionUser(this.ctx, userId);
      c.roleId = u?.roleId ?? null;
      this.send(c, { type: 'me-changed' });
    }
  }

  userRevoked(userId: string): void {
    for (const c of this.clients) {
      if (c.userId !== userId) continue;
      this.send(c, { type: 'me-changed' });
      c.ws.close(4001, 'Session ended');
      this.clients.delete(c);
    }
  }

  get connectionCount(): number {
    return this.clients.size;
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const c of this.clients) c.ws.terminate();
    this.clients.clear();
    this.wss.close();
  }
}
