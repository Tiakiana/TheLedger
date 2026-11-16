import os from 'node:os';
import { RateLimiter } from '../auth.js';
import { badRequest, notFound, tooMany } from '../errors.js';
import type { DonationInput, OverviewDTO, PlayerStateDTO } from '../shared/types.js';
import * as v from '../validate.js';
import { listAuditActions, queryAudit, type AuditQuery } from '../services/audit.js';
import * as catalog from '../services/catalog.js';
import type { Ctx } from '../services/context.js';
import * as donations from '../services/donations.js';
import { getInventory } from '../services/inventory.js';
import * as ops from '../services/operations.js';
import * as roles from '../services/roles.js';
import { getApprovalRequired, setApprovalRequired } from '../services/settings.js';
import * as users from '../services/users.js';
import { Router, SENT, type Req } from './router.js';

export const SESSION_COOKIE = 'ledger_session';

export function lanAddresses(port: number): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${port}`);
  }
  return out;
}

function isSecureRequest(ctx: Ctx, req: Req): boolean {
  if (ctx.config.cookieSecure) return true;
  if ((req.raw.socket as { encrypted?: boolean }).encrypted) return true;
  return ctx.config.trustProxy && String(req.raw.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';
}

function sessionCookie(ctx: Ctx, req: Req, token: string, maxAgeSeconds: number): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
    ...(isSecureRequest(ctx, req) ? ['Secure'] : []),
  ].join('; ');
}

function num(q: URLSearchParams, key: string): number | undefined {
  const s = q.get(key);
  if (s === null || s === '') return undefined;
  const n = Number(s);
  if (!Number.isFinite(n)) throw badRequest(`${key} must be a number.`);
  return n;
}

export function buildRoutes(ctx: Ctx, opts: { port: number }): Router {
  const r = new Router();
  const loginLimiter = new RateLimiter(10, 5 * 60_000);

  // ---------- auth ----------
  r.add('POST', '/api/auth/login', 'public', (req) => {
    const key = `${req.ip}|${String(req.body.username ?? '').toLowerCase()}`;
    if (!loginLimiter.hit(key)) throw tooMany('Too many login attempts. Wait a few minutes and try again.');
    const { token, user } = users.login(ctx, req.body.username, req.body.password);
    loginLimiter.reset(key);
    req.res.setHeader('Set-Cookie', sessionCookie(ctx, req, token, ctx.config.sessionTtlHours * 3600));
    return { user };
  });

  r.add('POST', '/api/auth/logout', 'public', (req) => {
    users.logout(ctx, req.token);
    req.res.setHeader('Set-Cookie', sessionCookie(ctx, req, '', 0));
    return { ok: true };
  });

  r.add('GET', '/api/auth/me', 'public', (req) => ({ user: req.user, serverNow: ctx.now() }));

  r.add('POST', '/api/auth/password', 'user', (req) => {
    users.changeOwnPassword(ctx, users.actorOf(req.user), req.body.currentPassword, req.body.newPassword, req.token);
    return { ok: true };
  });

  r.add('GET', '/api/images/:id', 'user', (req) => {
    const img = catalog.getImage(ctx, req.params.id);
    if (!img) throw notFound('Image not found.');
    req.res.writeHead(200, {
      'Content-Type': img.mime,
      'Content-Length': img.data.byteLength,
      'Cache-Control': 'private, max-age=31536000, immutable',
      'Content-Security-Policy': "default-src 'none'",
    });
    req.res.end(Buffer.from(img.data));
    return SENT;
  });

  // ---------- player ----------
  r.add('GET', '/api/me/state', 'user', (req): PlayerStateDTO => {
    const me = req.user;
    const base = { serverNow: ctx.now(), me, approvalRequired: getApprovalRequired(ctx) };
    if (!me.roleId) return { ...base, inventory: null, members: [], outgoing: [], incoming: [], recent: [] };
    const members = ctx.db
      .all<{ username: string }>('SELECT u.username FROM role_assignments a JOIN users u ON u.id = a.user_id WHERE a.role_id = ? ORDER BY u.username COLLATE NOCASE', me.roleId)
      .map((m) => m.username);
    return { ...base, inventory: getInventory(ctx, me.roleId), members, ...donations.donationsForRole(ctx, me.roleId) };
  });

  r.add('GET', '/api/roles/directory', 'player', (req) => ({ roles: roles.roleDirectory(ctx, req.user.roleId) }));

  r.add('POST', '/api/me/inventory/reorder', 'player', (req) => {
    ops.playerReorder(ctx, users.actorOf(req.user), req.body.entryId, req.body.beforeEntryId);
    return { ok: true };
  });

  r.add('POST', '/api/donations/validate', 'player', (req) => {
    const plan = donations.planDonation(ctx, users.actorOf(req.user), req.body as unknown as DonationInput);
    return { ok: true, recipient: { id: plan.recipient.id, name: plan.recipient.name }, lineCount: plan.lines.length };
  });

  r.add('POST', '/api/donations', 'player', (req) => ({ donation: donations.createDonation(ctx, users.actorOf(req.user), req.body as unknown as DonationInput) }));
  r.add('GET', '/api/donations/:id', 'player', (req) => ({ donation: donations.getDonationForPlayer(ctx, users.actorOf(req.user), req.params.id) }));
  r.add('POST', '/api/donations/:id/cancel', 'player', (req) => ({ donation: donations.cancelDonation(ctx, users.actorOf(req.user), req.params.id) }));
  r.add('POST', '/api/donations/:id/accept', 'player', (req) => ({ donation: donations.acceptDonation(ctx, users.actorOf(req.user), req.params.id) }));
  r.add('POST', '/api/donations/:id/reject', 'player', (req) => ({ donation: donations.rejectDonation(ctx, users.actorOf(req.user), req.params.id) }));

  // ---------- GM ----------
  const gm = (req: Req & { user: NonNullable<Req['user']> }) => users.actorOf(req.user);

  r.add('GET', '/api/gm/overview', 'gm', (): OverviewDTO => {
    const count = (sql: string) => ctx.db.get<{ n: number }>(sql)!.n;
    return {
      serverNow: ctx.now(),
      counts: {
        players: count('SELECT COUNT(*) AS n FROM users WHERE is_gm = 0'),
        roles: count('SELECT COUNT(*) AS n FROM roles'),
        itemDefinitions: count('SELECT COUNT(*) AS n FROM item_definitions'),
        currencies: count('SELECT COUNT(*) AS n FROM currencies'),
        activeDonations: count("SELECT COUNT(*) AS n FROM donations WHERE status IN ('countdown', 'pending')"),
      },
      approvalRequired: getApprovalRequired(ctx),
      activeDonations: donations.listDonations(ctx, { status: 'active', limit: 50 }),
      recentEvents: queryAudit(ctx, { limit: 12 }).events,
      lanAddresses: lanAddresses(opts.port),
    };
  });

  // players
  r.add('GET', '/api/gm/players', 'gm', (req) => ({ players: users.listPlayers(ctx, req.query.get('q') ?? undefined) }));
  r.add('POST', '/api/gm/players', 'gm', (req) => ({ player: users.createPlayer(ctx, gm(req), req.body) }));
  r.add('PATCH', '/api/gm/players/:id', 'gm', (req) => ({ player: users.updatePlayer(ctx, gm(req), req.params.id, req.body) }));
  r.add('POST', '/api/gm/players/:id/password', 'gm', (req) => {
    users.resetPassword(ctx, gm(req), req.params.id, req.body.password);
    return { ok: true };
  });
  r.add('POST', '/api/gm/players/:id/assign', 'gm', (req) => {
    const roleId = req.body.roleId === null || req.body.roleId === undefined || req.body.roleId === '' ? null : v.id(req.body.roleId, 'Role');
    return { player: users.assignRole(ctx, gm(req), req.params.id, roleId) };
  });
  r.add('DELETE', '/api/gm/players/:id', 'gm', (req) => {
    users.deletePlayer(ctx, gm(req), req.params.id);
    return { ok: true };
  });

  // roles
  r.add('GET', '/api/gm/roles', 'gm', (req) => ({ roles: roles.listRoles(ctx, req.query.get('q') ?? undefined) }));
  r.add('POST', '/api/gm/roles', 'gm', (req) => ({ role: roles.createRole(ctx, gm(req), req.body.name) }));
  r.add('PATCH', '/api/gm/roles/:id', 'gm', (req) => ({ role: roles.renameRole(ctx, gm(req), req.params.id, req.body.name) }));
  r.add('POST', '/api/gm/roles/:id/duplicate', 'gm', (req) => ({ role: roles.duplicateRole(ctx, gm(req), req.params.id, req.body.name) }));
  r.add('DELETE', '/api/gm/roles/:id', 'gm', (req) => {
    roles.deleteRole(ctx, gm(req), req.params.id, req.body.confirmName);
    return { ok: true };
  });

  // inventories
  r.add('GET', '/api/gm/roles/:id/inventory', 'gm', (req) => ({ inventory: getInventory(ctx, req.params.id), ...donations.donationsForRole(ctx, req.params.id), serverNow: ctx.now() }));
  r.add('POST', '/api/gm/roles/:id/items', 'gm', (req) => {
    ops.gmAddItem(ctx, gm(req), req.params.id, req.body);
    return { ok: true };
  });
  r.add('POST', '/api/gm/roles/:id/reorder', 'gm', (req) => {
    ops.gmReorder(ctx, gm(req), req.params.id, req.body.entryId, req.body.beforeEntryId);
    return { ok: true };
  });
  r.add('POST', '/api/gm/roles/:id/currencies/:currencyId', 'gm', (req) => ({
    amount: ops.gmAdjustBalance(ctx, gm(req), req.params.id, req.params.currencyId, req.body),
  }));
  r.add('PATCH', '/api/gm/entries/:id', 'gm', (req) => {
    if (req.body.quantity !== undefined) ops.gmSetQuantity(ctx, gm(req), req.params.id, req.body.quantity);
    if (req.body.customName !== undefined || req.body.customDescription !== undefined) ops.gmUpdateEntry(ctx, gm(req), req.params.id, req.body);
    return { ok: true };
  });
  r.add('DELETE', '/api/gm/entries/:id', 'gm', (req) => {
    ops.gmDeleteEntry(ctx, gm(req), req.params.id);
    return { ok: true };
  });
  r.add('POST', '/api/gm/entries/:id/move', 'gm', (req) => {
    ops.gmMoveEntry(ctx, gm(req), req.params.id, req.body);
    return { ok: true };
  });

  // item definitions & images
  r.add('GET', '/api/gm/item-definitions', 'gm', () => ({ itemDefinitions: catalog.listItemDefs(ctx) }));
  r.add('POST', '/api/gm/item-definitions', 'gm', (req) => ({ itemDefinition: catalog.createItemDef(ctx, gm(req), req.body) }));
  r.add('PATCH', '/api/gm/item-definitions/:id', 'gm', (req) => ({ itemDefinition: catalog.updateItemDef(ctx, gm(req), req.params.id, req.body) }));
  r.add('DELETE', '/api/gm/item-definitions/:id', 'gm', (req) => catalog.deleteItemDef(ctx, gm(req), req.params.id));
  r.add('POST', '/api/gm/images', 'gm', (req) => catalog.uploadImage(ctx, req.body));

  // currencies
  r.add('GET', '/api/gm/currencies', 'gm', () => ({ currencies: catalog.listCurrencyDTOs(ctx) }));
  r.add('POST', '/api/gm/currencies', 'gm', (req) => ({ currency: catalog.createCurrency(ctx, gm(req), req.body) }));
  r.add('PATCH', '/api/gm/currencies/:id', 'gm', (req) => ({ currency: catalog.updateCurrency(ctx, gm(req), req.params.id, req.body) }));
  r.add('DELETE', '/api/gm/currencies/:id', 'gm', (req) => {
    catalog.deleteCurrency(ctx, gm(req), req.params.id);
    return { ok: true };
  });
  r.add('GET', '/api/gm/currencies/:id/balances', 'gm', (req) => ({ balances: ops.balancesForCurrency(ctx, req.params.id) }));
  r.add('POST', '/api/gm/currency-transfers', 'gm', (req) => {
    ops.gmTransferCurrency(ctx, gm(req), req.body);
    return { ok: true };
  });

  // donations & audit
  r.add('GET', '/api/gm/donations', 'gm', (req) => ({
    donations: donations.listDonations(ctx, { status: req.query.get('status') ?? undefined, roleId: req.query.get('roleId') ?? undefined, limit: num(req.query, 'limit'), before: num(req.query, 'before') }),
    serverNow: ctx.now(),
  }));
  r.add('GET', '/api/gm/audit', 'gm', (req) => {
    const q = req.query;
    const assetType = q.get('assetType');
    const query: AuditQuery = {
      userId: q.get('userId') || undefined,
      roleId: q.get('roleId') || undefined,
      assetType: assetType === 'item' || assetType === 'currency' ? assetType : undefined,
      assetId: q.get('assetId') || undefined,
      category: q.get('category') || undefined,
      action: q.get('action') || undefined,
      donationId: q.get('donationId') || undefined,
      text: q.get('text') || undefined,
      from: num(q, 'from'),
      to: num(q, 'to'),
      before: num(q, 'before'),
      limit: num(q, 'limit'),
    };
    return queryAudit(ctx, query);
  });
  r.add('GET', '/api/gm/audit/actions', 'gm', () => ({ actions: listAuditActions(ctx) }));

  // settings
  r.add('GET', '/api/gm/settings', 'gm', () => ({ approvalRequired: getApprovalRequired(ctx), lanAddresses: lanAddresses(opts.port) }));
  r.add('PUT', '/api/gm/settings', 'gm', (req) => {
    if (req.body.approvalRequired !== undefined) setApprovalRequired(ctx, gm(req), v.bool(req.body.approvalRequired, 'Approval required'));
    return { approvalRequired: getApprovalRequired(ctx) };
  });

  return r;
}
