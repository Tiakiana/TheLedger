import type { AuditAssetDTO, AuditEventDTO } from '../shared/types.js';
import type { Actor, Ctx } from './context.js';

export interface AuditInput {
  category: 'donation' | 'gm' | 'inventory' | 'auth' | 'system';
  action: string;
  actor: Actor | null;
  role?: { id: string; name: string } | null;
  counterparty?: { id: string; name: string } | null;
  donationId?: string | null;
  summary: string;
  details?: unknown;
  assets?: AuditAssetDTO[];
}

/** Appends a permanent audit record. Must be called inside the transaction that made the change. */
export function writeAudit(ctx: Ctx, e: AuditInput): number {
  const r = ctx.db.run(
    `INSERT INTO audit_events (at, category, action, actor_user_id, actor_username, actor_is_gm, role_id, role_name,
       counterparty_role_id, counterparty_role_name, donation_id, summary, details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ctx.now(),
    e.category,
    e.action,
    e.actor?.userId ?? null,
    e.actor?.username ?? null,
    e.actor?.isGm ?? false,
    e.role?.id ?? null,
    e.role?.name ?? null,
    e.counterparty?.id ?? null,
    e.counterparty?.name ?? null,
    e.donationId ?? null,
    e.summary,
    e.details === undefined ? null : JSON.stringify(e.details),
  );
  for (const a of e.assets ?? []) {
    ctx.db.run(
      'INSERT INTO audit_event_assets (event_id, asset_type, asset_id, asset_name, instance_id, quantity) VALUES (?, ?, ?, ?, ?, ?)',
      r.lastInsertRowid,
      a.assetType,
      a.assetId,
      a.assetName,
      a.instanceId,
      a.quantity,
    );
  }
  return r.lastInsertRowid;
}

export interface AuditQuery {
  userId?: string;
  roleId?: string;
  assetType?: 'item' | 'currency';
  assetId?: string;
  category?: string;
  action?: string;
  donationId?: string;
  from?: number;
  to?: number;
  /** Return events with id < before (for paging, newest first). */
  before?: number;
  limit?: number;
  text?: string;
}

interface AuditRow {
  id: number;
  at: number;
  category: AuditEventDTO['category'];
  action: string;
  actor_user_id: string | null;
  actor_username: string | null;
  actor_is_gm: number;
  role_id: string | null;
  role_name: string | null;
  counterparty_role_id: string | null;
  counterparty_role_name: string | null;
  donation_id: string | null;
  summary: string;
  details: string | null;
}

export function queryAudit(ctx: Ctx, q: AuditQuery): { events: AuditEventDTO[]; nextBefore: number | null } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (q.userId) {
    where.push('e.actor_user_id = ?');
    params.push(q.userId);
  }
  if (q.roleId) {
    where.push('(e.role_id = ? OR e.counterparty_role_id = ?)');
    params.push(q.roleId, q.roleId);
  }
  if (q.assetId) {
    where.push('EXISTS (SELECT 1 FROM audit_event_assets a WHERE a.event_id = e.id AND a.asset_id = ?' + (q.assetType ? ' AND a.asset_type = ?' : '') + ')');
    params.push(q.assetId);
    if (q.assetType) params.push(q.assetType);
  } else if (q.assetType) {
    where.push('EXISTS (SELECT 1 FROM audit_event_assets a WHERE a.event_id = e.id AND a.asset_type = ?)');
    params.push(q.assetType);
  }
  if (q.category) {
    where.push('e.category = ?');
    params.push(q.category);
  }
  if (q.action) {
    // Accept either an exact action ("donation.completed") or a prefix ("donation.").
    if (q.action.endsWith('.')) {
      where.push("e.action LIKE ? ESCAPE '\\'");
      params.push(q.action.replace(/[%_\\]/g, '\\$&') + '%');
    } else {
      where.push('e.action = ?');
      params.push(q.action);
    }
  }
  if (q.donationId) {
    where.push('e.donation_id = ?');
    params.push(q.donationId);
  }
  if (q.from !== undefined) {
    where.push('e.at >= ?');
    params.push(q.from);
  }
  if (q.to !== undefined) {
    where.push('e.at < ?');
    params.push(q.to);
  }
  if (q.before !== undefined) {
    where.push('e.id < ?');
    params.push(q.before);
  }
  if (q.text) {
    where.push("(e.summary LIKE ? ESCAPE '\\' OR e.donation_id LIKE ? ESCAPE '\\')");
    const like = '%' + q.text.replace(/[%_\\]/g, '\\$&') + '%';
    params.push(like, like);
  }
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 500);
  const rows = ctx.db.all<AuditRow>(
    `SELECT e.* FROM audit_events e ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.id DESC LIMIT ?`,
    ...params,
    limit + 1,
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return { events: hydrate(ctx, page), nextBefore: hasMore ? page[page.length - 1].id : null };
}

function hydrate(ctx: Ctx, rows: AuditRow[]): AuditEventDTO[] {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const assets = ctx.db.all<{ event_id: number; asset_type: 'item' | 'currency'; asset_id: string; asset_name: string; instance_id: string | null; quantity: string | null }>(
    `SELECT * FROM audit_event_assets WHERE event_id IN (${ids.map(() => '?').join(',')})`,
    ...ids,
  );
  const byEvent = new Map<number, AuditAssetDTO[]>();
  for (const a of assets) {
    const list = byEvent.get(a.event_id) ?? [];
    list.push({ assetType: a.asset_type, assetId: a.asset_id, assetName: a.asset_name, instanceId: a.instance_id, quantity: a.quantity });
    byEvent.set(a.event_id, list);
  }
  return rows.map((r) => ({
    id: r.id,
    at: r.at,
    category: r.category,
    action: r.action,
    actorUserId: r.actor_user_id,
    actorUsername: r.actor_username,
    actorIsGm: r.actor_is_gm === 1,
    roleId: r.role_id,
    roleName: r.role_name,
    counterpartyRoleId: r.counterparty_role_id,
    counterpartyRoleName: r.counterparty_role_name,
    donationId: r.donation_id,
    summary: r.summary,
    details: r.details ? JSON.parse(r.details) : null,
    assets: byEvent.get(r.id) ?? [],
  }));
}

export function listAuditActions(ctx: Ctx): string[] {
  return ctx.db.all<{ action: string }>('SELECT DISTINCT action FROM audit_events ORDER BY action').map((r) => r.action);
}
