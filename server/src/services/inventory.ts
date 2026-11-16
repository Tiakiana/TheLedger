import { badRequest, conflict, notFound } from '../errors.js';
import { addUnits, formatAmount } from '../money.js';
import type { BalanceDTO, CurrencyDTO, EntryDTO, InventoryDTO, ItemDefDTO } from '../shared/types.js';
import { newId, type Ctx } from './context.js';

export interface RoleRow {
  id: string;
  name: string;
  created_at: number;
}

export interface EntryRow {
  id: string;
  inventory_id: string;
  item_def_id: string;
  kind: 'stack' | 'unique';
  quantity: number;
  custom_name: string | null;
  custom_description: string | null;
  acquired_at: number;
  position: number;
}

export interface DefRow {
  id: string;
  name: string;
  description: string;
  image_id: string | null;
  stackable: number;
  created_at: number;
  updated_at: number;
}

export interface CurrencyRow {
  id: string;
  name: string;
  icon_image_id: string | null;
  precision: number;
  min_units: number | null;
  max_units: number | null;
  gauge: 'none' | 'bar' | 'dial';
  color: string;
  position: number;
  created_at: number;
  updated_at: number;
}

export const imageUrl = (id: string | null): string | null => (id ? `/api/images/${id}` : null);

// ---------- lookups ----------

export function findRole(ctx: Ctx, roleId: string): RoleRow | undefined {
  return ctx.db.get<RoleRow>('SELECT * FROM roles WHERE id = ?', roleId);
}

export function requireRole(ctx: Ctx, roleId: string): RoleRow {
  const r = findRole(ctx, roleId);
  if (!r) throw notFound('That role does not exist.');
  return r;
}

export function inventoryIdOf(ctx: Ctx, roleId: string): string {
  const r = ctx.db.get<{ id: string }>('SELECT id FROM inventories WHERE role_id = ?', roleId);
  if (!r) throw notFound('That role has no inventory.');
  return r.id;
}

export function roleOfInventory(ctx: Ctx, inventoryId: string): RoleRow {
  const r = ctx.db.get<RoleRow>('SELECT r.* FROM roles r JOIN inventories i ON i.role_id = r.id WHERE i.id = ?', inventoryId);
  if (!r) throw notFound('Inventory not found.');
  return r;
}

export function requireDef(ctx: Ctx, defId: string): DefRow {
  const d = ctx.db.get<DefRow>('SELECT * FROM item_definitions WHERE id = ?', defId);
  if (!d) throw notFound('That item definition does not exist.');
  return d;
}

export function requireCurrency(ctx: Ctx, currencyId: string): CurrencyRow {
  const c = ctx.db.get<CurrencyRow>('SELECT * FROM currencies WHERE id = ?', currencyId);
  if (!c) throw notFound('That currency does not exist.');
  return c;
}

export function requireEntry(ctx: Ctx, entryId: string): EntryRow {
  const e = ctx.db.get<EntryRow>('SELECT * FROM inventory_entries WHERE id = ?', entryId);
  if (!e) throw notFound('That item is no longer in the inventory.');
  return e;
}

export function entryDisplayName(ctx: Ctx, e: EntryRow): string {
  return e.custom_name ?? requireDef(ctx, e.item_def_id).name;
}

// ---------- reservations ----------

export function reservedForEntry(ctx: Ctx, entryId: string): number {
  return ctx.db.get<{ n: number }>('SELECT COALESCE(SUM(quantity), 0) AS n FROM asset_reservations WHERE entry_id = ?', entryId)!.n;
}

export function reservedForCurrency(ctx: Ctx, inventoryId: string, currencyId: string): number {
  return ctx.db.get<{ n: number }>(
    'SELECT COALESCE(SUM(quantity), 0) AS n FROM asset_reservations WHERE inventory_id = ? AND currency_id = ?',
    inventoryId,
    currencyId,
  )!.n;
}

// ---------- currency balances ----------

export function getBalance(ctx: Ctx, inventoryId: string, currencyId: string): number {
  return ctx.db.get<{ units: number }>('SELECT units FROM currency_balances WHERE inventory_id = ? AND currency_id = ?', inventoryId, currencyId)?.units ?? 0;
}

/** The lowest balance allowed by the currency's configuration. Without a minimum, balances cannot go negative. */
export function effectiveMin(c: CurrencyRow): number {
  return c.min_units ?? 0;
}

export function assertWithinLimits(c: CurrencyRow, units: number, whose = 'The balance'): void {
  const min = effectiveMin(c);
  if (units < min) throw conflict(`${whose} of ${c.name} cannot go below ${formatAmount(min, c.precision)}.`);
  if (c.max_units !== null && units > c.max_units) throw conflict(`${whose} of ${c.name} cannot exceed ${formatAmount(c.max_units, c.precision)}.`);
}

export function setBalance(ctx: Ctx, inventoryId: string, c: CurrencyRow, units: number): void {
  ctx.db.run(
    `INSERT INTO currency_balances (inventory_id, currency_id, units, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (inventory_id, currency_id) DO UPDATE SET units = excluded.units, updated_at = excluded.updated_at`,
    inventoryId,
    c.id,
    units,
    ctx.now(),
  );
}

export function creditBalance(ctx: Ctx, inventoryId: string, c: CurrencyRow, units: number, whose?: string): number {
  const next = addUnits(getBalance(ctx, inventoryId, c.id), units);
  assertWithinLimits(c, next, whose);
  setBalance(ctx, inventoryId, c, next);
  return next;
}

// ---------- items ----------

export function nextPosition(ctx: Ctx, inventoryId: string): number {
  return ctx.db.get<{ p: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM inventory_entries WHERE inventory_id = ?', inventoryId)!.p;
}

/**
 * Adds items to an inventory. Stackable definitions merge into the inventory's single stack;
 * unique definitions create one new instance (with a fresh instance id) per unit.
 */
export function addItems(
  ctx: Ctx,
  inventoryId: string,
  def: DefRow,
  quantity: number,
  opts: { customName?: string | null; customDescription?: string | null } = {},
): EntryRow[] {
  const now = ctx.now();
  if (def.stackable) {
    const existing = ctx.db.get<EntryRow>("SELECT * FROM inventory_entries WHERE inventory_id = ? AND item_def_id = ? AND kind = 'stack'", inventoryId, def.id);
    if (existing) {
      const q = existing.quantity + quantity;
      if (q > 1_000_000_000) throw badRequest('That stack would become too large.');
      ctx.db.run('UPDATE inventory_entries SET quantity = ?, acquired_at = ? WHERE id = ?', q, now, existing.id);
      return [{ ...existing, quantity: q, acquired_at: now }];
    }
    const row: EntryRow = {
      id: newId(),
      inventory_id: inventoryId,
      item_def_id: def.id,
      kind: 'stack',
      quantity,
      custom_name: null,
      custom_description: null,
      acquired_at: now,
      position: nextPosition(ctx, inventoryId),
    };
    insertEntry(ctx, row);
    return [row];
  }
  if (quantity > 500) throw badRequest('Create at most 500 unique items at a time.');
  const rows: EntryRow[] = [];
  let pos = nextPosition(ctx, inventoryId);
  for (let i = 0; i < quantity; i++) {
    const row: EntryRow = {
      id: newId(),
      inventory_id: inventoryId,
      item_def_id: def.id,
      kind: 'unique',
      quantity: 1,
      custom_name: opts.customName ?? null,
      custom_description: opts.customDescription ?? null,
      acquired_at: now,
      position: pos++,
    };
    insertEntry(ctx, row);
    rows.push(row);
  }
  return rows;
}

export function insertEntry(ctx: Ctx, r: EntryRow): void {
  ctx.db.run(
    `INSERT INTO inventory_entries (id, inventory_id, item_def_id, kind, quantity, custom_name, custom_description, acquired_at, position)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    r.id,
    r.inventory_id,
    r.item_def_id,
    r.kind,
    r.quantity,
    r.custom_name,
    r.custom_description,
    r.acquired_at,
    r.position,
  );
}

/** Removes `quantity` units from an entry, deleting it when it reaches zero. Caller checks reservations. */
export function takeFromEntry(ctx: Ctx, entry: EntryRow, quantity: number): void {
  if (quantity > entry.quantity) throw conflict('Not enough items.');
  if (quantity === entry.quantity) ctx.db.run('DELETE FROM inventory_entries WHERE id = ?', entry.id);
  else ctx.db.run('UPDATE inventory_entries SET quantity = quantity - ? WHERE id = ?', quantity, entry.id);
}

/** Moves a unique instance (keeping its instance id) to another inventory, appended at the end. */
export function moveUnique(ctx: Ctx, entry: EntryRow, toInventoryId: string): void {
  ctx.db.run(
    'UPDATE inventory_entries SET inventory_id = ?, acquired_at = ?, position = ? WHERE id = ?',
    toInventoryId,
    ctx.now(),
    nextPosition(ctx, toInventoryId),
    entry.id,
  );
}

/**
 * Updates the role's persistent custom order: places `entryId` immediately before
 * `beforeEntryId` (or at the end when null), then renumbers positions 0..n-1.
 */
export function reorderEntry(ctx: Ctx, inventoryId: string, entryId: string, beforeEntryId: string | null): void {
  const ids = ctx.db.all<{ id: string }>('SELECT id FROM inventory_entries WHERE inventory_id = ? ORDER BY position, id', inventoryId).map((r) => r.id);
  const from = ids.indexOf(entryId);
  if (from < 0) throw notFound('That item is no longer in the inventory.');
  if (beforeEntryId === entryId) return;
  ids.splice(from, 1);
  let to = ids.length;
  if (beforeEntryId !== null) {
    to = ids.indexOf(beforeEntryId);
    if (to < 0) throw notFound('The target position no longer exists. Please try again.');
  }
  ids.splice(to, 0, entryId);
  const current = new Map(
    ctx.db.all<{ id: string; position: number }>('SELECT id, position FROM inventory_entries WHERE inventory_id = ?', inventoryId).map((r) => [r.id, r.position]),
  );
  ids.forEach((id, i) => {
    if (current.get(id) !== i) ctx.db.run('UPDATE inventory_entries SET position = ? WHERE id = ?', i, id);
  });
}

// ---------- DTOs ----------

export function defToDTO(d: DefRow): ItemDefDTO {
  return {
    id: d.id,
    name: d.name,
    description: d.description,
    imageId: d.image_id,
    imageUrl: imageUrl(d.image_id),
    stackable: d.stackable === 1,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  };
}

export function currencyToDTO(c: CurrencyRow): CurrencyDTO {
  return {
    id: c.id,
    name: c.name,
    iconImageId: c.icon_image_id,
    iconUrl: imageUrl(c.icon_image_id),
    precision: c.precision,
    min: c.min_units === null ? null : formatAmount(c.min_units, c.precision),
    max: c.max_units === null ? null : formatAmount(c.max_units, c.precision),
    gauge: c.gauge,
    color: c.color,
    position: c.position,
  };
}

export function listCurrencies(ctx: Ctx): CurrencyRow[] {
  return ctx.db.all<CurrencyRow>('SELECT * FROM currencies ORDER BY position, name');
}

export function getInventory(ctx: Ctx, roleId: string): InventoryDTO {
  const role = requireRole(ctx, roleId);
  const inventoryId = inventoryIdOf(ctx, roleId);
  const rows = ctx.db.all<EntryRow & { def_name: string; def_description: string; image_id: string | null; reserved: number }>(
    `SELECT e.*, d.name AS def_name, d.description AS def_description, d.image_id,
            COALESCE((SELECT SUM(r.quantity) FROM asset_reservations r WHERE r.entry_id = e.id), 0) AS reserved
       FROM inventory_entries e JOIN item_definitions d ON d.id = e.item_def_id
      WHERE e.inventory_id = ?
      ORDER BY e.position, e.id`,
    inventoryId,
  );
  const entries: EntryDTO[] = rows.map((r) => ({
    id: r.id,
    itemDefId: r.item_def_id,
    kind: r.kind,
    name: r.custom_name ?? r.def_name,
    description: r.custom_description ?? r.def_description,
    defName: r.def_name,
    customName: r.custom_name,
    customDescription: r.custom_description,
    imageUrl: imageUrl(r.image_id),
    quantity: r.quantity,
    reserved: r.reserved,
    available: r.quantity - r.reserved,
    acquiredAt: r.acquired_at,
    position: r.position,
  }));
  const currencies = listCurrencies(ctx);
  const balances: BalanceDTO[] = currencies.map((c) => {
    const units = getBalance(ctx, inventoryId, c.id);
    const reserved = reservedForCurrency(ctx, inventoryId, c.id);
    return {
      currencyId: c.id,
      amount: formatAmount(units, c.precision),
      reserved: formatAmount(reserved, c.precision),
      available: formatAmount(Math.max(0, units - reserved - Math.max(0, effectiveMin(c))), c.precision),
    };
  });
  return { role: { id: role.id, name: role.name }, entries, currencies: currencies.map(currencyToDTO), balances };
}
