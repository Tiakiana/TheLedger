import { badRequest, conflict } from '../errors.js';
import { addUnits, formatAmount, parseAmount, subUnits } from '../money.js';
import type { AuditAssetDTO } from '../shared/types.js';
import * as v from '../validate.js';
import { writeAudit } from './audit.js';
import type { Actor, Ctx } from './context.js';
import { requirePlayerRole } from './donations.js';
import {
  addItems,
  assertWithinLimits,
  effectiveMin,
  getBalance,
  inventoryIdOf,
  moveUnique,
  reorderEntry,
  requireCurrency,
  requireDef,
  requireEntry,
  requireRole,
  reservedForCurrency,
  reservedForEntry,
  roleOfInventory,
  setBalance,
  takeFromEntry,
  type EntryRow,
} from './inventory.js';

function itemAsset(entry: EntryRow, name: string, quantity: number | null): AuditAssetDTO {
  return { assetType: 'item', assetId: entry.item_def_id, assetName: name, instanceId: entry.kind === 'unique' ? entry.id : null, quantity: quantity === null ? null : String(quantity) };
}

function nameOf(ctx: Ctx, e: EntryRow): string {
  return e.custom_name ?? requireDef(ctx, e.item_def_id).name;
}

function parseBefore(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  return v.id(input, 'Target position');
}

// ---------- custom ordering ----------

/** Any player of a role can rearrange the role's shared, persistent custom order. */
export function playerReorder(ctx: Ctx, actor: Actor, entryIdInput: unknown, beforeInput: unknown): void {
  const entryId = v.id(entryIdInput, 'Item');
  const before = parseBefore(beforeInput);
  ctx.tx(() => {
    const role = requirePlayerRole(ctx, actor);
    const inv = inventoryIdOf(ctx, role.id);
    reorderEntry(ctx, inv, entryId, before);
    ctx.emit((s) => s.changed([role.id], { gm: false }));
  });
}

export function gmReorder(ctx: Ctx, _actor: Actor, roleId: string, entryIdInput: unknown, beforeInput: unknown): void {
  const entryId = v.id(entryIdInput, 'Item');
  const before = parseBefore(beforeInput);
  ctx.tx(() => {
    requireRole(ctx, roleId);
    reorderEntry(ctx, inventoryIdOf(ctx, roleId), entryId, before);
    ctx.emit((s) => s.changed([roleId], { gm: true }));
  });
}

// ---------- GM item operations ----------

export function gmAddItem(ctx: Ctx, actor: Actor, roleId: string, input: { itemDefId?: unknown; quantity?: unknown; customName?: unknown; customDescription?: unknown }): void {
  const defId = v.id(input.itemDefId, 'Item definition');
  const quantity = v.positiveInt(input.quantity ?? 1);
  ctx.tx(() => {
    const role = requireRole(ctx, roleId);
    const def = requireDef(ctx, defId);
    const customName = def.stackable ? null : v.optText(input.customName, 'Custom name', 80);
    const customDescription = def.stackable ? null : v.optText(input.customDescription, 'Custom description', 2000);
    const rows = addItems(ctx, inventoryIdOf(ctx, roleId), def, quantity, { customName, customDescription });
    const display = customName ?? def.name;
    writeAudit(ctx, {
      category: 'gm',
      action: 'gm.item.added',
      actor,
      role,
      summary: `Added ${quantity}× ${display} to ${role.name}`,
      assets: def.stackable ? [itemAsset(rows[0], def.name, quantity)] : rows.map((r) => itemAsset(r, display, 1)),
    });
    ctx.emit((s) => s.changed([roleId], { gm: true }));
  });
}

/** Sets a stack's quantity (0 removes it). Cannot drop below the amount reserved by in-flight donations. */
export function gmSetQuantity(ctx: Ctx, actor: Actor, entryId: string, quantityInput: unknown): void {
  const quantity = quantityInput === 0 || quantityInput === '0' ? 0 : v.positiveInt(quantityInput);
  ctx.tx(() => {
    const e = requireEntry(ctx, entryId);
    if (e.kind !== 'stack') throw badRequest('Unique items always have a quantity of 1. Add or delete instances instead.');
    const role = roleOfInventory(ctx, e.inventory_id);
    const reserved = reservedForEntry(ctx, e.id);
    if (quantity < reserved) throw conflict(`${reserved} of these are reserved by an in-flight donation; the quantity cannot go below ${reserved}.`);
    if (quantity === e.quantity) return;
    const name = nameOf(ctx, e);
    if (quantity === 0) ctx.db.run('DELETE FROM inventory_entries WHERE id = ?', e.id);
    else ctx.db.run('UPDATE inventory_entries SET quantity = ?, acquired_at = CASE WHEN ? > quantity THEN ? ELSE acquired_at END WHERE id = ?', quantity, quantity, ctx.now(), e.id);
    writeAudit(ctx, {
      category: 'gm',
      action: 'gm.item.quantity-set',
      actor,
      role,
      summary: `Set ${name} in ${role.name} from ${e.quantity} to ${quantity}`,
      assets: [itemAsset(e, name, quantity - e.quantity)],
      details: { from: e.quantity, to: quantity },
    });
    ctx.emit((s) => s.changed([role.id], { gm: true }));
  });
}

export function gmUpdateEntry(ctx: Ctx, actor: Actor, entryId: string, input: { customName?: unknown; customDescription?: unknown }): void {
  ctx.tx(() => {
    const e = requireEntry(ctx, entryId);
    if (e.kind !== 'unique') throw badRequest('Only unique items can have their own name and description.');
    const role = roleOfInventory(ctx, e.inventory_id);
    const customName = input.customName !== undefined ? v.optText(input.customName, 'Custom name', 80) : e.custom_name;
    const customDescription = input.customDescription !== undefined ? v.optText(input.customDescription, 'Custom description', 2000) : e.custom_description;
    ctx.db.run('UPDATE inventory_entries SET custom_name = ?, custom_description = ? WHERE id = ?', customName, customDescription, e.id);
    const def = requireDef(ctx, e.item_def_id);
    writeAudit(ctx, {
      category: 'gm',
      action: 'gm.item.edited',
      actor,
      role,
      summary: `Edited unique item ${customName ?? def.name} in ${role.name}`,
      assets: [itemAsset(e, customName ?? def.name, null)],
      details: { before: { customName: e.custom_name, customDescription: e.custom_description }, after: { customName, customDescription } },
    });
    ctx.emit((s) => s.changed([role.id], { gm: true }));
  });
}

export function gmDeleteEntry(ctx: Ctx, actor: Actor, entryId: string): void {
  ctx.tx(() => {
    const e = requireEntry(ctx, entryId);
    const role = roleOfInventory(ctx, e.inventory_id);
    if (reservedForEntry(ctx, e.id) > 0) throw conflict('This item is reserved by an in-flight donation and cannot be removed until it resolves.');
    const name = nameOf(ctx, e);
    ctx.db.run('DELETE FROM inventory_entries WHERE id = ?', e.id);
    writeAudit(ctx, {
      category: 'gm',
      action: 'gm.item.removed',
      actor,
      role,
      summary: `Removed ${e.kind === 'stack' ? `${e.quantity}× ` : ''}${name} from ${role.name}`,
      assets: [itemAsset(e, name, -e.quantity)],
    });
    ctx.emit((s) => s.changed([role.id], { gm: true }));
  });
}

/** Moves a unique item, or part of a stack, to another role. Reserved units cannot move. */
export function gmMoveEntry(ctx: Ctx, actor: Actor, entryId: string, input: { toRoleId?: unknown; quantity?: unknown }): void {
  const toRoleId = v.id(input.toRoleId, 'Destination role');
  ctx.tx(() => {
    const e = requireEntry(ctx, entryId);
    const from = roleOfInventory(ctx, e.inventory_id);
    const to = requireRole(ctx, toRoleId);
    if (from.id === to.id) throw badRequest('The item is already in that inventory.');
    const available = e.quantity - reservedForEntry(ctx, e.id);
    const quantity = e.kind === 'unique' ? 1 : v.positiveInt(input.quantity ?? e.quantity);
    if (quantity > available) throw conflict(available <= 0 ? 'This item is reserved by an in-flight donation.' : `Only ${available} can be moved (the rest are reserved).`);
    const name = nameOf(ctx, e);
    const toInv = inventoryIdOf(ctx, to.id);
    if (e.kind === 'unique') moveUnique(ctx, e, toInv);
    else {
      takeFromEntry(ctx, e, quantity);
      addItems(ctx, toInv, requireDef(ctx, e.item_def_id), quantity);
    }
    writeAudit(ctx, {
      category: 'gm',
      action: 'gm.item.moved',
      actor,
      role: from,
      counterparty: to,
      summary: `Moved ${e.kind === 'stack' ? `${quantity}× ` : ''}${name} from ${from.name} to ${to.name}`,
      assets: [itemAsset(e, name, quantity)],
    });
    ctx.emit((s) => s.changed([from.id, to.id], { gm: true }));
  });
}

// ---------- GM currency operations ----------

export type BalanceOp = 'set' | 'add' | 'subtract' | 'reset';

export function gmAdjustBalance(ctx: Ctx, actor: Actor, roleId: string, currencyId: string, input: { op?: unknown; amount?: unknown }): string {
  const op = input.op;
  if (op !== 'set' && op !== 'add' && op !== 'subtract' && op !== 'reset') throw badRequest('Choose set, add, subtract or reset.');
  return ctx.tx(() => {
    const role = requireRole(ctx, roleId);
    const c = requireCurrency(ctx, currencyId);
    const inv = inventoryIdOf(ctx, roleId);
    const before = getBalance(ctx, inv, c.id);
    let next: number;
    if (op === 'reset') {
      next = Math.min(Math.max(0, effectiveMin(c)), c.max_units ?? Number.MAX_SAFE_INTEGER);
    } else {
      const amount = parseAmount(input.amount, c.precision, { allowNegative: op === 'set', what: 'Amount' });
      if (op !== 'set' && amount <= 0) throw badRequest('Amount must be greater than zero.');
      next = op === 'set' ? amount : op === 'add' ? addUnits(before, amount) : subUnits(before, amount);
    }
    assertWithinLimits(c, next, `${role.name}'s balance`);
    const reserved = reservedForCurrency(ctx, inv, c.id);
    if (next - reserved < effectiveMin(c)) {
      throw conflict(`${formatAmount(reserved, c.precision)} ${c.name} is reserved by in-flight donations; the balance cannot go below ${formatAmount(reserved + effectiveMin(c), c.precision)}.`);
    }
    if (next === before) return formatAmount(next, c.precision);
    setBalance(ctx, inv, c, next);
    const delta = next - before;
    writeAudit(ctx, {
      category: 'gm',
      action: `gm.currency.${op}`,
      actor,
      role,
      summary: `${op === 'reset' ? 'Reset' : op === 'set' ? 'Set' : op === 'add' ? 'Added to' : 'Subtracted from'} ${role.name}'s ${c.name}: ${formatAmount(before, c.precision)} → ${formatAmount(next, c.precision)}`,
      assets: [{ assetType: 'currency', assetId: c.id, assetName: c.name, instanceId: null, quantity: (delta > 0 ? '+' : '') + formatAmount(delta, c.precision) }],
      details: { before: formatAmount(before, c.precision), after: formatAmount(next, c.precision) },
    });
    ctx.emit((s) => s.changed([roleId], { gm: true }));
    return formatAmount(next, c.precision);
  });
}

export function gmTransferCurrency(ctx: Ctx, actor: Actor, input: { fromRoleId?: unknown; toRoleId?: unknown; currencyId?: unknown; amount?: unknown }): void {
  const fromId = v.id(input.fromRoleId, 'Source role');
  const toId = v.id(input.toRoleId, 'Destination role');
  const currencyId = v.id(input.currencyId, 'Currency');
  ctx.tx(() => {
    if (fromId === toId) throw badRequest('Choose two different roles.');
    const from = requireRole(ctx, fromId);
    const to = requireRole(ctx, toId);
    const c = requireCurrency(ctx, currencyId);
    const amount = parseAmount(input.amount, c.precision);
    if (amount <= 0) throw badRequest('Amount must be greater than zero.');
    const fromInv = inventoryIdOf(ctx, fromId);
    const toInv = inventoryIdOf(ctx, toId);
    const fromBal = getBalance(ctx, fromInv, c.id);
    const available = fromBal - reservedForCurrency(ctx, fromInv, c.id) - effectiveMin(c);
    if (amount > available) throw conflict(`${from.name} only has ${formatAmount(Math.max(0, available), c.precision)} ${c.name} available.`);
    const toNext = addUnits(getBalance(ctx, toInv, c.id), amount);
    assertWithinLimits(c, toNext, `${to.name}'s balance`);
    setBalance(ctx, fromInv, c, fromBal - amount);
    setBalance(ctx, toInv, c, toNext);
    writeAudit(ctx, {
      category: 'gm',
      action: 'gm.currency.transferred',
      actor,
      role: from,
      counterparty: to,
      summary: `Transferred ${formatAmount(amount, c.precision)} ${c.name} from ${from.name} to ${to.name}`,
      assets: [{ assetType: 'currency', assetId: c.id, assetName: c.name, instanceId: null, quantity: formatAmount(amount, c.precision) }],
    });
    ctx.emit((s) => s.changed([fromId, toId], { gm: true }));
  });
}

export function balancesForCurrency(ctx: Ctx, currencyId: string): { roleId: string; roleName: string; amount: string; reserved: string }[] {
  const c = requireCurrency(ctx, currencyId);
  return ctx.db
    .all<{ role_id: string; role_name: string; units: number | null; reserved: number }>(
      `SELECT r.id AS role_id, r.name AS role_name, b.units,
              COALESCE((SELECT SUM(quantity) FROM asset_reservations x WHERE x.inventory_id = i.id AND x.currency_id = ?), 0) AS reserved
         FROM roles r JOIN inventories i ON i.role_id = r.id
         LEFT JOIN currency_balances b ON b.inventory_id = i.id AND b.currency_id = ?
        ORDER BY r.name COLLATE NOCASE`,
      c.id,
      c.id,
    )
    .map((r) => ({ roleId: r.role_id, roleName: r.role_name, amount: formatAmount(r.units ?? 0, c.precision), reserved: formatAmount(r.reserved, c.precision) }));
}
