import { badRequest, conflict } from '../errors.js';
import type { RoleAdminDTO, RoleRef } from '../shared/types.js';
import * as v from '../validate.js';
import { writeAudit } from './audit.js';
import { newId, type Actor, type Ctx } from './context.js';
import { cancelDonationsForRole } from './donations.js';
import { inventoryIdOf, requireRole, type EntryRow } from './inventory.js';

function assertNameFree(ctx: Ctx, name: string, exceptId?: string): void {
  const clash = ctx.db.get<{ id: string }>('SELECT id FROM roles WHERE name = ?', name);
  if (clash && clash.id !== exceptId) throw conflict(`A role named "${name}" already exists.`);
}

function insertRole(ctx: Ctx, name: string): { roleId: string; inventoryId: string } {
  const roleId = newId();
  const inventoryId = newId();
  const now = ctx.now();
  ctx.db.run('INSERT INTO roles (id, name, created_at) VALUES (?, ?, ?)', roleId, name, now);
  ctx.db.run('INSERT INTO inventories (id, role_id, created_at) VALUES (?, ?, ?)', inventoryId, roleId, now);
  return { roleId, inventoryId };
}

export function listRoles(ctx: Ctx, q?: string): RoleAdminDTO[] {
  const like = q ? `%${q.replace(/[%_\\]/g, '\\$&')}%` : null;
  const roles = ctx.db.all<{ id: string; name: string; created_at: number; entry_count: number; active: number }>(
    `SELECT r.*,
            (SELECT COUNT(*) FROM inventory_entries e JOIN inventories i ON i.id = e.inventory_id WHERE i.role_id = r.id) AS entry_count,
            (SELECT COUNT(*) FROM donations d WHERE d.status IN ('countdown', 'pending') AND (d.sender_role_id = r.id OR d.recipient_role_id = r.id)) AS active
       FROM roles r ${like ? "WHERE r.name LIKE ? ESCAPE '\\'" : ''}
      ORDER BY r.name COLLATE NOCASE`,
    ...(like ? [like] : []),
  );
  const players = ctx.db.all<{ role_id: string; id: string; username: string }>(
    'SELECT a.role_id, u.id, u.username FROM role_assignments a JOIN users u ON u.id = a.user_id ORDER BY u.username COLLATE NOCASE',
  );
  const byRole = new Map<string, { id: string; username: string }[]>();
  for (const p of players) byRole.set(p.role_id, [...(byRole.get(p.role_id) ?? []), { id: p.id, username: p.username }]);
  return roles.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, players: byRole.get(r.id) ?? [], entryCount: r.entry_count, activeDonations: r.active }));
}

/** The recipient directory players search when donating. */
export function roleDirectory(ctx: Ctx, excludeRoleId: string | null): RoleRef[] {
  return ctx.db.all<RoleRef>('SELECT id, name FROM roles WHERE id <> ? ORDER BY name COLLATE NOCASE', excludeRoleId ?? '');
}

export function createRole(ctx: Ctx, actor: Actor, nameInput: unknown): RoleAdminDTO {
  const name = v.name(nameInput, 'Role name');
  const { roleId } = ctx.tx(() => {
    assertNameFree(ctx, name);
    const r = insertRole(ctx, name);
    writeAudit(ctx, { category: 'gm', action: 'gm.role.created', actor, role: { id: r.roleId, name }, summary: `Created role ${name}` });
    ctx.emit((s) => s.changed([], { gm: true, catalog: true }));
    return r;
  });
  return listRoles(ctx).find((r) => r.id === roleId)!;
}

export function renameRole(ctx: Ctx, actor: Actor, roleId: string, nameInput: unknown): RoleAdminDTO {
  const name = v.name(nameInput, 'Role name');
  ctx.tx(() => {
    const role = requireRole(ctx, roleId);
    if (role.name === name) return;
    assertNameFree(ctx, name, roleId);
    ctx.db.run('UPDATE roles SET name = ? WHERE id = ?', name, roleId);
    writeAudit(ctx, { category: 'gm', action: 'gm.role.renamed', actor, role: { id: roleId, name }, summary: `Renamed role ${role.name} to ${name}`, details: { from: role.name, to: name } });
    ctx.emit((s) => {
      s.changed([roleId], { gm: true, catalog: true });
      for (const u of ctx.db.all<{ user_id: string }>('SELECT user_id FROM role_assignments WHERE role_id = ?', roleId)) s.userChanged(u.user_id);
    });
  });
  return listRoles(ctx).find((r) => r.id === roleId)!;
}

function uniqueCopyName(ctx: Ctx, base: string): string {
  const stem = base.replace(/ \(copy(?: \d+)?\)$/i, '');
  for (let i = 1; i < 1000; i++) {
    const candidate = `${stem} (copy${i === 1 ? '' : ' ' + i})`.slice(0, 80);
    if (!ctx.db.get('SELECT 1 FROM roles WHERE name = ?', candidate)) return candidate;
  }
  throw conflict('Could not find a free name for the copy.');
}

/**
 * Creates an independent copy of a role: every stack, every unique item (with new instance ids,
 * same visible properties), every currency balance and the saved custom order.
 * Player assignments and pending donations are not copied; the original is untouched.
 */
export function duplicateRole(ctx: Ctx, actor: Actor, roleId: string, nameInput?: unknown): RoleAdminDTO {
  const newRoleId = ctx.tx(() => {
    const source = requireRole(ctx, roleId);
    const name = nameInput ? v.name(nameInput, 'Role name') : uniqueCopyName(ctx, source.name);
    assertNameFree(ctx, name);
    const srcInv = inventoryIdOf(ctx, roleId);
    const { roleId: newRole, inventoryId: newInv } = insertRole(ctx, name);
    const entries = ctx.db.all<EntryRow>('SELECT * FROM inventory_entries WHERE inventory_id = ? ORDER BY position, id', srcInv);
    const idMap: Record<string, string> = {};
    for (const e of entries) {
      const id = newId();
      idMap[e.id] = id;
      ctx.db.run(
        `INSERT INTO inventory_entries (id, inventory_id, item_def_id, kind, quantity, custom_name, custom_description, acquired_at, position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        newInv,
        e.item_def_id,
        e.kind,
        e.quantity,
        e.custom_name,
        e.custom_description,
        e.acquired_at,
        e.position,
      );
    }
    const balances = ctx.db.run(
      'INSERT INTO currency_balances (inventory_id, currency_id, units, updated_at) SELECT ?, currency_id, units, ? FROM currency_balances WHERE inventory_id = ?',
      newInv,
      ctx.now(),
      srcInv,
    );
    writeAudit(ctx, {
      category: 'gm',
      action: 'gm.role.duplicated',
      actor,
      role: { id: newRole, name },
      counterparty: { id: source.id, name: source.name },
      summary: `Duplicated ${source.name} as ${name} (${entries.length} inventory entr${entries.length === 1 ? 'y' : 'ies'}, ${balances.changes} balance${balances.changes === 1 ? '' : 's'})`,
      details: { sourceRoleId: source.id, instanceIdMap: idMap },
    });
    ctx.emit((s) => s.changed([], { gm: true, catalog: true }));
    return newRole;
  });
  return listRoles(ctx).find((r) => r.id === newRoleId)!;
}

/** Deletes a role and its inventory. Requires typing the role name. Active donations involving it are cancelled first. */
export function deleteRole(ctx: Ctx, actor: Actor, roleId: string, confirmName: unknown): void {
  ctx.tx(() => {
    const role = requireRole(ctx, roleId);
    if (typeof confirmName !== 'string' || confirmName.trim().toLowerCase() !== role.name.toLowerCase()) {
      throw badRequest(`Type the role name "${role.name}" to confirm deletion.`);
    }
    const members = ctx.db.all<{ user_id: string }>('SELECT user_id FROM role_assignments WHERE role_id = ?', roleId);
    const cancelled = cancelDonationsForRole(ctx, actor, roleId);
    const inv = inventoryIdOf(ctx, roleId);
    const contents = ctx.db.get<{ n: number; units: number }>('SELECT COUNT(*) AS n, COALESCE(SUM(quantity), 0) AS units FROM inventory_entries WHERE inventory_id = ?', inv)!;
    ctx.db.run('DELETE FROM roles WHERE id = ?', roleId); // cascades: inventory, entries, balances, assignments
    writeAudit(ctx, {
      category: 'gm',
      action: 'gm.role.deleted',
      actor,
      role: { id: role.id, name: role.name },
      summary: `Deleted role ${role.name} (${contents.units} item unit${contents.units === 1 ? '' : 's'} removed, ${members.length} player${members.length === 1 ? '' : 's'} unassigned, ${cancelled} active donation${cancelled === 1 ? '' : 's'} cancelled)`,
      details: { unassignedUserIds: members.map((m) => m.user_id) },
    });
    ctx.emit((s) => {
      s.changed([roleId], { gm: true, catalog: true });
      for (const m of members) s.userChanged(m.user_id);
    });
  });
}
