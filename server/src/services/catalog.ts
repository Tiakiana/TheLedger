import { badRequest, conflict, notFound } from '../errors.js';
import { formatAmount, parseAmount, rescaleUnits, MAX_PRECISION } from '../money.js';
import type { CurrencyDTO, GaugeStyle, ItemDefDTO } from '../shared/types.js';
import * as v from '../validate.js';
import { writeAudit } from './audit.js';
import { newId, type Actor, type Ctx } from './context.js';
import { currencyToDTO, defToDTO, listCurrencies, requireCurrency, requireDef, type CurrencyRow, type DefRow } from './inventory.js';

// ---------- images ----------

const MIME_SIGNATURES: Record<string, (b: Buffer) => boolean> = {
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => b.subarray(0, 4).toString('ascii') === 'GIF8',
  'image/webp': (b) => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP',
};

/** Stores an uploaded image (PNG, JPEG, GIF or WebP; SVG is refused because it can carry scripts). */
export function uploadImage(ctx: Ctx, input: { dataBase64?: unknown; mime?: unknown }): { id: string; url: string } {
  if (typeof input.dataBase64 !== 'string' || typeof input.mime !== 'string') throw badRequest('Image data is required.');
  const mime = input.mime.toLowerCase();
  const check = MIME_SIGNATURES[mime];
  if (!check) throw badRequest('Images must be PNG, JPEG, GIF or WebP.');
  const b64 = input.dataBase64.replace(/^data:[^;]+;base64,/, '');
  const data = Buffer.from(b64, 'base64');
  if (data.length === 0) throw badRequest('The image is empty.');
  if (data.length > ctx.config.maxImageBytes) throw badRequest(`Images must be at most ${Math.round(ctx.config.maxImageBytes / 1024)} KB.`);
  if (!check(data)) throw badRequest('The file content does not match its image type.');
  const id = newId();
  ctx.db.run('INSERT INTO images (id, mime, data, created_at) VALUES (?, ?, ?, ?)', id, mime, data, ctx.now());
  return { id, url: `/api/images/${id}` };
}

export function getImage(ctx: Ctx, id: string): { mime: string; data: Uint8Array } | null {
  return ctx.db.get<{ mime: string; data: Uint8Array }>('SELECT mime, data FROM images WHERE id = ?', id) ?? null;
}

function optionalImageId(ctx: Ctx, input: unknown): string | null {
  if (input === null || input === undefined || input === '') return null;
  const id = v.id(input, 'Image');
  if (!ctx.db.get('SELECT 1 FROM images WHERE id = ?', id)) throw notFound('That image does not exist. Upload it again.');
  return id;
}

// ---------- item definitions ----------

export function listItemDefs(ctx: Ctx): ItemDefDTO[] {
  const usage = new Map(
    ctx.db.all<{ item_def_id: string; n: number }>('SELECT item_def_id, SUM(quantity) AS n FROM inventory_entries GROUP BY item_def_id').map((r) => [r.item_def_id, r.n]),
  );
  return ctx.db
    .all<DefRow>('SELECT * FROM item_definitions ORDER BY name COLLATE NOCASE')
    .map((d) => ({ ...defToDTO(d), inUse: usage.get(d.id) ?? 0 }));
}

export function createItemDef(ctx: Ctx, actor: Actor, input: { name?: unknown; description?: unknown; stackable?: unknown; imageId?: unknown }): ItemDefDTO {
  const name = v.name(input.name, 'Item name');
  const description = v.str(input.description, 'Description', { optional: true, max: 2000 });
  const stackable = v.bool(input.stackable, 'Stackable');
  const id = newId();
  ctx.tx(() => {
    const imageId = optionalImageId(ctx, input.imageId);
    const now = ctx.now();
    ctx.db.run(
      'INSERT INTO item_definitions (id, name, description, image_id, stackable, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id,
      name,
      description,
      imageId,
      stackable,
      now,
      now,
    );
    writeAudit(ctx, {
      category: 'gm',
      action: 'gm.item-def.created',
      actor,
      summary: `Created ${stackable ? 'stackable' : 'unique'} item definition "${name}"`,
      assets: [{ assetType: 'item', assetId: id, assetName: name, instanceId: null, quantity: null }],
    });
    ctx.emit((s) => s.changed([], { gm: true, catalog: true }));
  });
  return defToDTO(requireDef(ctx, id));
}

export function updateItemDef(ctx: Ctx, actor: Actor, id: string, input: { name?: unknown; description?: unknown; stackable?: unknown; imageId?: unknown }): ItemDefDTO {
  ctx.tx(() => {
    const d = requireDef(ctx, id);
    const name = input.name !== undefined ? v.name(input.name, 'Item name') : d.name;
    const description = input.description !== undefined ? v.str(input.description, 'Description', { optional: true, max: 2000 }) : d.description;
    const imageId = input.imageId !== undefined ? optionalImageId(ctx, input.imageId) : d.image_id;
    let stackable = d.stackable === 1;
    if (input.stackable !== undefined) {
      const want = v.bool(input.stackable, 'Stackable');
      if (want !== stackable) {
        if (ctx.db.get('SELECT 1 FROM inventory_entries WHERE item_def_id = ? LIMIT 1', id)) {
          throw conflict('Stackable/unique cannot be changed while any inventory holds this item.');
        }
        stackable = want;
      }
    }
    ctx.db.run('UPDATE item_definitions SET name = ?, description = ?, image_id = ?, stackable = ?, updated_at = ? WHERE id = ?', name, description, imageId, stackable, ctx.now(), id);
    writeAudit(ctx, {
      category: 'gm',
      action: 'gm.item-def.updated',
      actor,
      summary: `Edited item definition "${name}"${name !== d.name ? ` (was "${d.name}")` : ''}`,
      assets: [{ assetType: 'item', assetId: id, assetName: name, instanceId: null, quantity: null }],
    });
    const roles = ctx.db.all<{ role_id: string }>('SELECT DISTINCT i.role_id FROM inventory_entries e JOIN inventories i ON i.id = e.inventory_id WHERE e.item_def_id = ?', id);
    ctx.emit((s) =>
      s.changed(
        roles.map((r) => r.role_id),
        { gm: true, catalog: true },
      ),
    );
  });
  return defToDTO(requireDef(ctx, id));
}

/** Deletes a definition and removes it from every inventory. Refused while any unit is reserved by a donation. */
export function deleteItemDef(ctx: Ctx, actor: Actor, id: string): { removedUnits: number } {
  return ctx.tx(() => {
    const d = requireDef(ctx, id);
    if (ctx.db.get('SELECT 1 FROM asset_reservations r JOIN inventory_entries e ON e.id = r.entry_id WHERE e.item_def_id = ? LIMIT 1', id)) {
      throw conflict(`"${d.name}" is part of an in-flight donation. Wait for it to resolve before deleting.`);
    }
    const holders = ctx.db.all<{ role_id: string; role_name: string; units: number }>(
      `SELECT i.role_id, r.name AS role_name, SUM(e.quantity) AS units FROM inventory_entries e
         JOIN inventories i ON i.id = e.inventory_id JOIN roles r ON r.id = i.role_id
        WHERE e.item_def_id = ? GROUP BY i.role_id`,
      id,
    );
    const removed = holders.reduce((a, h) => a + h.units, 0);
    ctx.db.run('DELETE FROM inventory_entries WHERE item_def_id = ?', id);
    ctx.db.run('DELETE FROM item_definitions WHERE id = ?', id);
    writeAudit(ctx, {
      category: 'gm',
      action: 'gm.item-def.deleted',
      actor,
      summary: `Deleted item definition "${d.name}" (${removed} unit${removed === 1 ? '' : 's'} removed from ${holders.length} inventor${holders.length === 1 ? 'y' : 'ies'})`,
      assets: [{ assetType: 'item', assetId: id, assetName: d.name, instanceId: null, quantity: String(removed) }],
      details: { holders },
    });
    ctx.emit((s) =>
      s.changed(
        holders.map((h) => h.role_id),
        { gm: true, catalog: true },
      ),
    );
    return { removedUnits: removed };
  });
}

// ---------- currencies ----------

interface CurrencyInput {
  name?: unknown;
  precision?: unknown;
  min?: unknown;
  max?: unknown;
  gauge?: unknown;
  color?: unknown;
  iconImageId?: unknown;
}

function parseGauge(input: unknown): GaugeStyle {
  if (input === undefined || input === null) return 'none';
  if (input !== 'none' && input !== 'bar' && input !== 'dial') throw badRequest('Gauge must be none, bar or dial.');
  return input;
}

function parseColor(input: unknown, fallback: string): string {
  if (input === undefined || input === null || input === '') return fallback;
  if (typeof input !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(input)) throw badRequest('Color must look like #A1B2C3.');
  return input;
}

function parsePrecision(input: unknown, fallback: number): number {
  if (input === undefined || input === null) return fallback;
  if (typeof input !== 'number' || !Number.isInteger(input) || input < 0 || input > MAX_PRECISION) throw badRequest(`Precision must be a whole number from 0 to ${MAX_PRECISION}.`);
  return input;
}

function parseLimit(input: unknown, precision: number, what: string): number | null {
  if (input === undefined || input === null || input === '') return null;
  return parseAmount(input, precision, { allowNegative: true, what });
}

export function listCurrencyDTOs(ctx: Ctx): CurrencyDTO[] {
  return listCurrencies(ctx).map(currencyToDTO);
}

export function createCurrency(ctx: Ctx, actor: Actor, input: CurrencyInput): CurrencyDTO {
  const name = v.name(input.name, 'Currency name', 40);
  const precision = parsePrecision(input.precision, 0);
  const min = parseLimit(input.min, precision, 'Minimum');
  const max = parseLimit(input.max, precision, 'Maximum');
  if (min !== null && max !== null && min > max) throw badRequest('Minimum cannot be greater than maximum.');
  if ((min ?? 0) > 0) throw badRequest('Minimum cannot be above zero, because new roles start at zero.');
  if (max !== null && max < 0) throw badRequest('Maximum cannot be below zero, because new roles start at zero.');
  const gauge = parseGauge(input.gauge);
  const color = parseColor(input.color, '#b07d2b');
  const id = newId();
  ctx.tx(() => {
    if (ctx.db.get('SELECT 1 FROM currencies WHERE name = ?', name)) throw conflict(`A currency named "${name}" already exists.`);
    const icon = optionalImageId(ctx, input.iconImageId);
    const pos = ctx.db.get<{ p: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM currencies')!.p;
    const now = ctx.now();
    ctx.db.run(
      `INSERT INTO currencies (id, name, icon_image_id, precision, min_units, max_units, gauge, color, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      name,
      icon,
      precision,
      min,
      max,
      gauge,
      color,
      pos,
      now,
      now,
    );
    writeAudit(ctx, {
      category: 'gm',
      action: 'gm.currency.created',
      actor,
      summary: `Created currency "${name}"`,
      assets: [{ assetType: 'currency', assetId: id, assetName: name, instanceId: null, quantity: null }],
      details: { precision, min: input.min ?? null, max: input.max ?? null, gauge },
    });
    ctx.emit((s) => s.changed([], { gm: true, catalog: true }));
  });
  return currencyToDTO(requireCurrency(ctx, id));
}

export function updateCurrency(ctx: Ctx, actor: Actor, id: string, input: CurrencyInput): CurrencyDTO {
  ctx.tx(() => {
    const c = requireCurrency(ctx, id);
    const name = input.name !== undefined ? v.name(input.name, 'Currency name', 40) : c.name;
    if (name.toLowerCase() !== c.name.toLowerCase()) {
      if (ctx.db.get('SELECT 1 FROM currencies WHERE name = ?', name)) throw conflict(`A currency named "${name}" already exists.`);
    }
    const precision = parsePrecision(input.precision, c.precision);
    if (precision !== c.precision) {
      if (ctx.db.get('SELECT 1 FROM asset_reservations WHERE currency_id = ? LIMIT 1', id)) {
        throw conflict('Precision cannot change while a donation of this currency is in flight.');
      }
      const balances = ctx.db.all<{ inventory_id: string; units: number }>('SELECT inventory_id, units FROM currency_balances WHERE currency_id = ?', id);
      for (const b of balances) {
        const next = rescaleUnits(b.units, c.precision, precision);
        if (next === null) throw conflict(`Lowering the precision would lose fractional amounts in existing balances.`);
        ctx.db.run('UPDATE currency_balances SET units = ? WHERE inventory_id = ? AND currency_id = ?', next, b.inventory_id, id);
      }
    }
    const rescale = (u: number | null) => (u === null ? null : rescaleUnits(u, c.precision, precision));
    const min = input.min !== undefined ? parseLimit(input.min, precision, 'Minimum') : rescale(c.min_units);
    const max = input.max !== undefined ? parseLimit(input.max, precision, 'Maximum') : rescale(c.max_units);
    if (min !== null && max !== null && min > max) throw badRequest('Minimum cannot be greater than maximum.');
    if ((min ?? 0) > 0) throw badRequest('Minimum cannot be above zero, because roles without a balance hold zero.');
    if (max !== null && max < 0) throw badRequest('Maximum cannot be below zero, because roles without a balance hold zero.');
    const outside = ctx.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM currency_balances WHERE currency_id = ? AND (units < ? OR (? IS NOT NULL AND units > ?))',
      id,
      min ?? 0,
      max,
      max,
    )!.n;
    if (outside > 0) throw conflict(`${outside} role balance${outside === 1 ? ' is' : 's are'} outside the new limits. Adjust them first.`);
    const gauge = input.gauge !== undefined ? parseGauge(input.gauge) : c.gauge;
    const color = input.color !== undefined ? parseColor(input.color, c.color) : c.color;
    const icon = input.iconImageId !== undefined ? optionalImageId(ctx, input.iconImageId) : c.icon_image_id;
    ctx.db.run(
      'UPDATE currencies SET name = ?, icon_image_id = ?, precision = ?, min_units = ?, max_units = ?, gauge = ?, color = ?, updated_at = ? WHERE id = ?',
      name,
      icon,
      precision,
      min,
      max,
      gauge,
      color,
      ctx.now(),
      id,
    );
    writeAudit(ctx, {
      category: 'gm',
      action: 'gm.currency.updated',
      actor,
      summary: `Edited currency "${name}"`,
      assets: [{ assetType: 'currency', assetId: id, assetName: name, instanceId: null, quantity: null }],
      details: {
        precision,
        min: min === null ? null : formatAmount(min, precision),
        max: max === null ? null : formatAmount(max, precision),
        gauge,
      },
    });
    ctx.emit((s) => s.changed([], { gm: true, catalog: true }));
  });
  return currencyToDTO(requireCurrency(ctx, id));
}

export function deleteCurrency(ctx: Ctx, actor: Actor, id: string): void {
  ctx.tx(() => {
    const c: CurrencyRow = requireCurrency(ctx, id);
    if (ctx.db.get('SELECT 1 FROM asset_reservations WHERE currency_id = ? LIMIT 1', id)) {
      throw conflict(`"${c.name}" is part of an in-flight donation. Wait for it to resolve before deleting.`);
    }
    const holders = ctx.db.all<{ role_name: string; units: number }>(
      `SELECT r.name AS role_name, b.units FROM currency_balances b JOIN inventories i ON i.id = b.inventory_id JOIN roles r ON r.id = i.role_id
        WHERE b.currency_id = ? AND b.units <> 0`,
      id,
    );
    ctx.db.run('DELETE FROM currencies WHERE id = ?', id); // cascades balances
    writeAudit(ctx, {
      category: 'gm',
      action: 'gm.currency.deleted',
      actor,
      summary: `Deleted currency "${c.name}" (${holders.length} non-zero balance${holders.length === 1 ? '' : 's'} removed)`,
      assets: [{ assetType: 'currency', assetId: id, assetName: c.name, instanceId: null, quantity: null }],
      details: { balances: holders.map((h) => ({ role: h.role_name, amount: formatAmount(h.units, c.precision) })) },
    });
    ctx.emit((s) => s.changed([], { gm: true, catalog: true }));
  });
}
