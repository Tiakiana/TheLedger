import { AppError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import { formatAmount, parseAmount, subUnits } from '../money.js';
import type { AuditAssetDTO, DonationDTO, DonationInput, DonationLineDTO, DonationStatus } from '../shared/types.js';
import { writeAudit } from './audit.js';
import { newDonationId, newId, type Actor, type Ctx } from './context.js';
import {
  addItems,
  creditBalance,
  effectiveMin,
  getBalance,
  imageUrl,
  inventoryIdOf,
  moveUnique,
  requireCurrency,
  requireDef,
  reservedForCurrency,
  reservedForEntry,
  setBalance,
  takeFromEntry,
  findRole,
  type CurrencyRow,
  type EntryRow,
  type RoleRow,
} from './inventory.js';
import { getApprovalRequired } from './settings.js';

export const ACTIVE_STATUSES: DonationStatus[] = ['countdown', 'pending'];
const MAX_LINES = 200;

interface DonationRow {
  id: string;
  sender_role_id: string;
  sender_role_name: string;
  recipient_role_id: string;
  recipient_role_name: string;
  created_by_user_id: string | null;
  created_by_username: string;
  request_id: string | null;
  status: DonationStatus;
  created_at: number;
  cancel_deadline: number;
  approval_deadline: number | null;
  resolved_at: number | null;
  resolved_by_user_id: string | null;
  resolved_by_username: string | null;
  resolution_note: string | null;
}

interface LineRow {
  id: string;
  donation_id: string;
  line_no: number;
  asset_type: 'stack' | 'unique' | 'currency';
  item_def_id: string | null;
  entry_id: string | null;
  currency_id: string | null;
  quantity: number;
  precision: number | null;
  name_snapshot: string;
  image_id: string | null;
}

/** A validated donation line, ready to be reserved. */
type PlannedLine =
  | { assetType: 'stack' | 'unique'; entry: EntryRow; name: string; imageId: string | null; quantity: number }
  | { assetType: 'currency'; currency: CurrencyRow; quantity: number };

export interface DonationPlan {
  sender: RoleRow;
  recipient: RoleRow;
  senderInventoryId: string;
  lines: PlannedLine[];
}

/** The role the user is assigned to right now (read from the database, never from the client). */
export function currentRoleOf(ctx: Ctx, userId: string): RoleRow | null {
  return ctx.db.get<RoleRow>('SELECT r.* FROM roles r JOIN role_assignments a ON a.role_id = r.id WHERE a.user_id = ?', userId) ?? null;
}

export function requirePlayerRole(ctx: Ctx, actor: Actor): RoleRow {
  const role = currentRoleOf(ctx, actor.userId);
  if (!role) throw forbidden('You are not assigned to a role yet. Ask the GM to assign you one.');
  return role;
}

function lineAssets(lines: PlannedLine[] | LineRow[]): AuditAssetDTO[] {
  return lines.map((l) => {
    if ('asset_type' in l) {
      return l.asset_type === 'currency'
        ? { assetType: 'currency', assetId: l.currency_id!, assetName: l.name_snapshot, instanceId: null, quantity: formatAmount(l.quantity, l.precision ?? 0) }
        : { assetType: 'item', assetId: l.item_def_id!, assetName: l.name_snapshot, instanceId: l.asset_type === 'unique' ? l.entry_id : null, quantity: String(l.quantity) };
    }
    return l.assetType === 'currency'
      ? { assetType: 'currency', assetId: l.currency.id, assetName: l.currency.name, instanceId: null, quantity: formatAmount(l.quantity, l.currency.precision) }
      : { assetType: 'item', assetId: l.entry.item_def_id, assetName: l.name, instanceId: l.assetType === 'unique' ? l.entry.id : null, quantity: String(l.quantity) };
  });
}

function describeLines(lines: LineRow[]): string {
  const parts = lines.map((l) =>
    l.asset_type === 'currency' ? `${formatAmount(l.quantity, l.precision ?? 0)} ${l.name_snapshot}` : l.quantity === 1 ? l.name_snapshot : `${l.quantity}× ${l.name_snapshot}`,
  );
  return parts.length <= 3 ? parts.join(', ') : `${parts.slice(0, 3).join(', ')} and ${parts.length - 3} more`;
}

/**
 * Validates a donation request against current server state: role membership, recipient,
 * ownership and *available* (unreserved) quantities. Does not write anything.
 */
export function planDonation(ctx: Ctx, actor: Actor, input: DonationInput): DonationPlan {
  if (actor.isGm) throw forbidden('The GM moves assets with the GM tools rather than donations.');
  const sender = requirePlayerRole(ctx, actor);
  if (!input || typeof input.recipientRoleId !== 'string') throw badRequest('Choose a recipient role.');
  const recipient = findRole(ctx, input.recipientRoleId);
  if (!recipient) throw notFound('The recipient role no longer exists.');
  if (recipient.id === sender.id) throw badRequest('A role cannot donate to itself.');
  if (!Array.isArray(input.lines) || input.lines.length === 0) throw badRequest('Add at least one item or resource to the donation.');
  if (input.lines.length > MAX_LINES) throw badRequest(`A donation can contain at most ${MAX_LINES} lines.`);
  const senderInventoryId = inventoryIdOf(ctx, sender.id);
  const recipientInventoryId = inventoryIdOf(ctx, recipient.id);

  // Merge repeated references to the same asset so they are validated together.
  const itemQty = new Map<string, number>();
  const currencyQty = new Map<string, number>();
  const order: { kind: 'item' | 'currency'; id: string }[] = [];
  for (const raw of input.lines) {
    if (raw && raw.type === 'item') {
      if (typeof raw.entryId !== 'string') throw badRequest('Invalid item in donation.');
      const q = raw.quantity;
      if (typeof q !== 'number' || !Number.isInteger(q) || q <= 0) throw badRequest('Item quantities must be whole numbers greater than zero.');
      if (!itemQty.has(raw.entryId)) order.push({ kind: 'item', id: raw.entryId });
      itemQty.set(raw.entryId, (itemQty.get(raw.entryId) ?? 0) + q);
    } else if (raw && raw.type === 'currency') {
      if (typeof raw.currencyId !== 'string') throw badRequest('Invalid resource in donation.');
      const c = requireCurrency(ctx, raw.currencyId);
      const units = parseAmount(raw.amount, c.precision, { what: `${c.name} amount` });
      if (units <= 0) throw badRequest(`${c.name} amount must be greater than zero.`);
      if (!currencyQty.has(c.id)) order.push({ kind: 'currency', id: c.id });
      currencyQty.set(c.id, (currencyQty.get(c.id) ?? 0) + units);
    } else {
      throw badRequest('Invalid donation line.');
    }
  }

  const lines: PlannedLine[] = [];
  for (const o of order) {
    if (o.kind === 'item') {
      const entry = ctx.db.get<EntryRow>('SELECT * FROM inventory_entries WHERE id = ?', o.id);
      if (!entry || entry.inventory_id !== senderInventoryId) throw conflict('One of the items is no longer in your inventory.');
      const def = requireDef(ctx, entry.item_def_id);
      const name = entry.custom_name ?? def.name;
      const qty = itemQty.get(o.id)!;
      if (entry.kind === 'unique' && qty !== 1) throw badRequest(`${name} is a unique item; its quantity must be 1.`);
      const available = entry.quantity - reservedForEntry(ctx, entry.id);
      if (qty > available) {
        throw conflict(
          available <= 0
            ? `${name} is already reserved by another donation.`
            : `You only have ${available} ${name} available${entry.quantity !== available ? ` (${entry.quantity - available} reserved)` : ''}.`,
        );
      }
      lines.push({ assetType: entry.kind, entry, name, imageId: def.image_id, quantity: qty });
    } else {
      const c = requireCurrency(ctx, o.id);
      const units = currencyQty.get(o.id)!;
      const balance = getBalance(ctx, senderInventoryId, c.id);
      const available = balance - reservedForCurrency(ctx, senderInventoryId, c.id) - Math.max(0, effectiveMin(c));
      if (units > available) throw conflict(`You only have ${formatAmount(Math.max(0, available), c.precision)} ${c.name} available to donate.`);
      if (c.max_units !== null && getBalance(ctx, recipientInventoryId, c.id) + units > c.max_units) {
        throw conflict(`${recipient.name} cannot hold that much ${c.name} (maximum ${formatAmount(c.max_units, c.precision)}).`);
      }
      lines.push({ assetType: 'currency', currency: c, quantity: units });
    }
  }
  return { sender, recipient, senderInventoryId, lines };
}

/** Creates a donation: validates, reserves every asset atomically and starts the 5-second cancellation window. */
export function createDonation(ctx: Ctx, actor: Actor, input: DonationInput): DonationDTO {
  const requestId = typeof input?.requestId === 'string' && input.requestId.length > 0 && input.requestId.length <= 100 ? input.requestId : null;
  return ctx.tx(() => {
    if (requestId) {
      // Duplicate submission (double click, network retry): return the original donation.
      const existing = ctx.db.get<DonationRow>('SELECT * FROM donations WHERE created_by_user_id = ? AND request_id = ?', actor.userId, requestId);
      if (existing) return toDTO(ctx, existing);
    }
    const plan = planDonation(ctx, actor, input);
    const now = ctx.now();
    const id = newDonationId();
    const row: DonationRow = {
      id,
      sender_role_id: plan.sender.id,
      sender_role_name: plan.sender.name,
      recipient_role_id: plan.recipient.id,
      recipient_role_name: plan.recipient.name,
      created_by_user_id: actor.userId,
      created_by_username: actor.username,
      request_id: requestId,
      status: 'countdown',
      created_at: now,
      cancel_deadline: now + ctx.config.cancelWindowMs,
      approval_deadline: null,
      resolved_at: null,
      resolved_by_user_id: null,
      resolved_by_username: null,
      resolution_note: null,
    };
    ctx.db.run(
      `INSERT INTO donations (id, sender_role_id, sender_role_name, recipient_role_id, recipient_role_name, created_by_user_id,
         created_by_username, request_id, status, created_at, cancel_deadline)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'countdown', ?, ?)`,
      row.id,
      row.sender_role_id,
      row.sender_role_name,
      row.recipient_role_id,
      row.recipient_role_name,
      row.created_by_user_id,
      row.created_by_username,
      row.request_id,
      row.created_at,
      row.cancel_deadline,
    );
    plan.lines.forEach((l, i) => {
      const lineId = newId();
      if (l.assetType === 'currency') {
        ctx.db.run(
          `INSERT INTO donation_lines (id, donation_id, line_no, asset_type, currency_id, quantity, precision, name_snapshot, image_id)
           VALUES (?, ?, ?, 'currency', ?, ?, ?, ?, ?)`,
          lineId,
          id,
          i,
          l.currency.id,
          l.quantity,
          l.currency.precision,
          l.currency.name,
          l.currency.icon_image_id,
        );
        ctx.db.run(
          `INSERT INTO asset_reservations (id, donation_id, line_id, inventory_id, asset_type, currency_id, quantity, created_at)
           VALUES (?, ?, ?, ?, 'currency', ?, ?, ?)`,
          newId(),
          id,
          lineId,
          plan.senderInventoryId,
          l.currency.id,
          l.quantity,
          now,
        );
      } else {
        ctx.db.run(
          `INSERT INTO donation_lines (id, donation_id, line_no, asset_type, item_def_id, entry_id, quantity, name_snapshot, image_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          lineId,
          id,
          i,
          l.assetType,
          l.entry.item_def_id,
          l.entry.id,
          l.quantity,
          l.name,
          l.imageId,
        );
        // The partial unique index on unique-item reservations makes double reservation impossible at the database level.
        ctx.db.run(
          `INSERT INTO asset_reservations (id, donation_id, line_id, inventory_id, asset_type, entry_id, quantity, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          newId(),
          id,
          lineId,
          plan.senderInventoryId,
          l.assetType,
          l.entry.id,
          l.quantity,
          now,
        );
      }
    });
    const lines = linesOf(ctx, id);
    writeAudit(ctx, {
      category: 'donation',
      action: 'donation.created',
      actor,
      role: plan.sender,
      counterparty: plan.recipient,
      donationId: id,
      summary: `${actor.username} (${plan.sender.name}) offered ${describeLines(lines)} to ${plan.recipient.name}; assets reserved`,
      assets: lineAssets(lines),
      details: { cancelDeadline: row.cancel_deadline },
    });
    ctx.emit((s) => s.changed([plan.sender.id], { gm: true }));
    return toDTO(ctx, row);
  });
}

function requireDonation(ctx: Ctx, id: string): DonationRow {
  const d = ctx.db.get<DonationRow>('SELECT * FROM donations WHERE id = ?', id);
  if (!d) throw notFound('That donation does not exist.');
  return d;
}

function linesOf(ctx: Ctx, donationId: string): LineRow[] {
  return ctx.db.all<LineRow>('SELECT * FROM donation_lines WHERE donation_id = ? ORDER BY line_no', donationId);
}

function releaseReservations(ctx: Ctx, donationId: string): void {
  ctx.db.run('DELETE FROM asset_reservations WHERE donation_id = ?', donationId);
}

function resolve(ctx: Ctx, d: DonationRow, status: DonationStatus, by: Actor | null, note: string | null): void {
  const r = ctx.db.run(
    `UPDATE donations SET status = ?, resolved_at = ?, resolved_by_user_id = ?, resolved_by_username = ?, resolution_note = ?
      WHERE id = ? AND status = ?`,
    status,
    ctx.now(),
    by?.userId ?? null,
    by?.username ?? null,
    note,
    d.id,
    d.status,
  );
  // Compare-and-set: if the status changed under us, the donation was already resolved.
  if (r.changes !== 1) throw conflict('This donation has already been resolved.');
}

/** Sender-side cancellation, only possible before the server-side cancellation deadline. */
export function cancelDonation(ctx: Ctx, actor: Actor, id: string): DonationDTO {
  return ctx.tx(() => {
    const d = requireDonation(ctx, id);
    const role = currentRoleOf(ctx, actor.userId);
    if (!role || role.id !== d.sender_role_id) throw forbidden('Only players of the sending role can cancel this donation.');
    if (d.status !== 'countdown') throw conflict(d.status === 'pending' ? 'The cancellation window has closed; the donation is awaiting the recipient.' : 'This donation has already been resolved.');
    if (ctx.now() >= d.cancel_deadline) throw conflict('The cancellation window has closed.');
    releaseReservations(ctx, d.id);
    resolve(ctx, d, 'cancelled', actor, 'Cancelled by sender');
    writeAudit(ctx, {
      category: 'donation',
      action: 'donation.cancelled',
      actor,
      role: { id: d.sender_role_id, name: d.sender_role_name },
      counterparty: { id: d.recipient_role_id, name: d.recipient_role_name },
      donationId: d.id,
      summary: `${actor.username} cancelled donation to ${d.recipient_role_name}; reserved assets released`,
      assets: lineAssets(linesOf(ctx, d.id)),
    });
    ctx.emit((s) => s.changed([d.sender_role_id], { gm: true }));
    return toDTO(ctx, requireDonation(ctx, id));
  });
}

/**
 * Moves every reserved asset from sender to recipient. Runs in a savepoint: if any line
 * cannot be completed (e.g. recipient would exceed a currency maximum), nothing moves.
 */
function transfer(ctx: Ctx, d: DonationRow): void {
  const fromInv = inventoryIdOf(ctx, d.sender_role_id);
  const toInv = inventoryIdOf(ctx, d.recipient_role_id);
  const recipientName = d.recipient_role_name;
  const lines = linesOf(ctx, d.id);
  const reservations = new Map(
    ctx.db.all<{ line_id: string; quantity: number }>('SELECT line_id, quantity FROM asset_reservations WHERE donation_id = ?', d.id).map((r) => [r.line_id, r.quantity]),
  );
  for (const l of lines) {
    if (reservations.get(l.id) !== l.quantity) throw conflict(`The reservation for ${l.name_snapshot} is missing.`);
  }
  releaseReservations(ctx, d.id);
  for (const l of lines) {
    if (l.asset_type === 'currency') {
      const c = requireCurrency(ctx, l.currency_id!);
      const senderBal = getBalance(ctx, fromInv, c.id);
      const next = subUnits(senderBal, l.quantity);
      if (next < effectiveMin(c)) throw conflict(`${d.sender_role_name} no longer has enough ${c.name}.`);
      setBalance(ctx, fromInv, c, next);
      creditBalance(ctx, toInv, c, l.quantity, `${recipientName}'s balance`);
    } else {
      const entry = ctx.db.get<EntryRow>('SELECT * FROM inventory_entries WHERE id = ?', l.entry_id!);
      if (!entry || entry.inventory_id !== fromInv || entry.quantity < l.quantity) throw conflict(`${l.name_snapshot} is no longer available.`);
      if (entry.kind === 'unique') {
        moveUnique(ctx, entry, toInv);
      } else {
        takeFromEntry(ctx, entry, l.quantity);
        addItems(ctx, toInv, requireDef(ctx, entry.item_def_id), l.quantity);
      }
    }
  }
}

function complete(ctx: Ctx, d: DonationRow, by: Actor | null): { ok: boolean; message?: string } {
  const lines = linesOf(ctx, d.id);
  try {
    ctx.db.tx(() => transfer(ctx, d));
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    releaseReservations(ctx, d.id);
    resolve(ctx, d, 'failed', by, err.message);
    writeAudit(ctx, {
      category: 'donation',
      action: 'donation.failed',
      actor: by,
      role: { id: d.sender_role_id, name: d.sender_role_name },
      counterparty: { id: d.recipient_role_id, name: d.recipient_role_name },
      donationId: d.id,
      summary: `Donation to ${d.recipient_role_name} could not be completed: ${err.message} Assets returned to ${d.sender_role_name}.`,
      assets: lineAssets(lines),
    });
    ctx.emit((s) => {
      s.changed([d.sender_role_id, d.recipient_role_id], { gm: true });
      s.notifyRole(d.sender_role_id, { type: 'notify', kind: 'donation-failed', donationId: d.id, roleId: d.sender_role_id, text: `Donation to ${d.recipient_role_name} failed: ${err.message}` });
    });
    return { ok: false, message: err.message };
  }
  resolve(ctx, d, 'completed', by, by ? 'Accepted by recipient' : 'Completed automatically');
  writeAudit(ctx, {
    category: 'donation',
    action: 'donation.completed',
    actor: by,
    role: { id: d.sender_role_id, name: d.sender_role_name },
    counterparty: { id: d.recipient_role_id, name: d.recipient_role_name },
    donationId: d.id,
    summary: `${d.sender_role_name} → ${d.recipient_role_name}: ${describeLines(lines)} transferred${by ? ` (accepted by ${by.username})` : ''}`,
    assets: lineAssets(lines),
    details: { initiatedBy: d.created_by_username },
  });
  const text = `${d.sender_role_name} donated ${describeLines(lines)} to ${d.recipient_role_name}.`;
  ctx.emit((s) => {
    s.changed([d.sender_role_id, d.recipient_role_id], { gm: true });
    s.notifyRole(d.sender_role_id, { type: 'notify', kind: 'donation-completed', donationId: d.id, roleId: d.sender_role_id, text });
    s.notifyRole(d.recipient_role_id, { type: 'notify', kind: 'donation-completed', donationId: d.id, roleId: d.recipient_role_id, text });
  });
  return { ok: true };
}

function reject(ctx: Ctx, d: DonationRow, by: Actor | null, reason: 'rejected' | 'timeout' | 'role-deleted', note?: string): void {
  const lines = linesOf(ctx, d.id);
  releaseReservations(ctx, d.id);
  const resolutionNote =
    note ?? (reason === 'timeout' ? 'Automatically rejected: approval window expired' : reason === 'rejected' ? 'Rejected by recipient' : 'A role involved was deleted');
  const status: DonationStatus = reason === 'role-deleted' ? 'cancelled' : 'rejected';
  resolve(ctx, d, status, by, resolutionNote);
  writeAudit(ctx, {
    category: 'donation',
    action: reason === 'timeout' ? 'donation.expired' : reason === 'rejected' ? 'donation.rejected' : 'donation.cancelled',
    actor: by,
    role: { id: d.sender_role_id, name: d.sender_role_name },
    counterparty: { id: d.recipient_role_id, name: d.recipient_role_name },
    donationId: d.id,
    summary: `Donation from ${d.sender_role_name} to ${d.recipient_role_name}: ${resolutionNote.toLowerCase()}; assets released to ${d.sender_role_name}`,
    assets: lineAssets(lines),
  });
  ctx.emit((s) => {
    s.changed([d.sender_role_id, d.recipient_role_id], { gm: true });
    s.notifyRole(d.sender_role_id, {
      type: 'notify',
      kind: 'donation-rejected',
      donationId: d.id,
      roleId: d.sender_role_id,
      text: `${d.recipient_role_name} ${reason === 'timeout' ? 'did not respond in time' : 'declined your donation'}; your assets were returned.`,
    });
  });
}

export function acceptDonation(ctx: Ctx, actor: Actor, id: string): DonationDTO {
  const result = ctx.tx(() => {
    const d = requireDonation(ctx, id);
    const role = currentRoleOf(ctx, actor.userId);
    if (!role || role.id !== d.recipient_role_id) throw forbidden('Only players of the recipient role can accept this donation.');
    if (d.status !== 'pending') return { error: d.status === 'countdown' ? 'This donation is still in its cancellation window.' : 'This donation has already been resolved.' };
    if (ctx.now() >= d.approval_deadline!) {
      // Late approval: the deadline wins. Resolve as expired right now.
      reject(ctx, d, null, 'timeout');
      return { error: 'The approval window has closed; the donation was returned to the sender.' };
    }
    const r = complete(ctx, d, actor);
    return r.ok ? { error: null } : { error: `The donation could not be completed: ${r.message}` };
  });
  // Errors are raised after commit so that state changes made above (expiry, failure) persist.
  if (result.error) throw conflict(result.error);
  return getDonation(ctx, id);
}

export function rejectDonation(ctx: Ctx, actor: Actor, id: string): DonationDTO {
  const result = ctx.tx(() => {
    const d = requireDonation(ctx, id);
    const role = currentRoleOf(ctx, actor.userId);
    if (!role || role.id !== d.recipient_role_id) throw forbidden('Only players of the recipient role can reject this donation.');
    if (d.status !== 'pending') return { error: 'This donation has already been resolved.' };
    if (ctx.now() >= d.approval_deadline!) {
      reject(ctx, d, null, 'timeout');
      return { error: null };
    }
    reject(ctx, d, actor, 'rejected');
    return { error: null };
  });
  if (result.error) throw conflict(result.error);
  return getDonation(ctx, id);
}

/** Moves a donation whose cancellation window has passed to its next state. */
function advanceCountdown(ctx: Ctx, d: DonationRow): void {
  if (getApprovalRequired(ctx)) {
    // The approval window starts exactly when the cancellation window ends, independent of sweep latency.
    const deadline = d.cancel_deadline + ctx.config.approvalWindowMs;
    const r = ctx.db.run("UPDATE donations SET status = 'pending', approval_deadline = ? WHERE id = ? AND status = 'countdown'", deadline, d.id);
    if (r.changes !== 1) return;
    const lines = linesOf(ctx, d.id);
    writeAudit(ctx, {
      category: 'donation',
      action: 'donation.pending',
      actor: null,
      role: { id: d.sender_role_id, name: d.sender_role_name },
      counterparty: { id: d.recipient_role_id, name: d.recipient_role_name },
      donationId: d.id,
      summary: `Donation from ${d.sender_role_name} awaits approval by ${d.recipient_role_name}`,
      assets: lineAssets(lines),
      details: { approvalDeadline: deadline },
    });
    ctx.emit((s) => {
      s.changed([d.sender_role_id, d.recipient_role_id], { gm: true });
      s.notifyRole(d.recipient_role_id, {
        type: 'notify',
        kind: 'donation-pending',
        donationId: d.id,
        roleId: d.recipient_role_id,
        text: `${d.sender_role_name} wants to give you ${describeLines(lines)}. Accept or reject within 5 minutes.`,
      });
    });
  } else {
    complete(ctx, d, null);
  }
}

/**
 * Processes every donation whose server-side deadline has passed. Called on a short interval
 * and at startup, so deadlines are enforced even if browsers disconnect or the server restarts.
 */
export function processDueDonations(ctx: Ctx): number {
  let processed = 0;
  const now = ctx.now();
  const dueCountdowns = ctx.db.all<DonationRow>("SELECT * FROM donations WHERE status = 'countdown' AND cancel_deadline <= ? ORDER BY cancel_deadline", now);
  for (const d of dueCountdowns) {
    ctx.tx(() => {
      const fresh = requireDonation(ctx, d.id);
      if (fresh.status === 'countdown') advanceCountdown(ctx, fresh);
    });
    processed++;
  }
  const duePending = ctx.db.all<DonationRow>("SELECT * FROM donations WHERE status = 'pending' AND approval_deadline <= ? ORDER BY approval_deadline", ctx.now());
  for (const d of duePending) {
    ctx.tx(() => {
      const fresh = requireDonation(ctx, d.id);
      if (fresh.status === 'pending') reject(ctx, fresh, null, 'timeout');
    });
    processed++;
  }
  return processed;
}

/** Earliest upcoming deadline among active donations, used to schedule the next sweep precisely. */
export function nextDeadline(ctx: Ctx): number | null {
  const r = ctx.db.get<{ t: number | null }>(
    "SELECT MIN(CASE WHEN status = 'countdown' THEN cancel_deadline ELSE approval_deadline END) AS t FROM donations WHERE status IN ('countdown', 'pending')",
  );
  return r?.t ?? null;
}

/** Cancels all active donations involving a role (used before the role is deleted). */
export function cancelDonationsForRole(ctx: Ctx, actor: Actor, roleId: string): number {
  const active = ctx.db.all<DonationRow>(
    "SELECT * FROM donations WHERE status IN ('countdown', 'pending') AND (sender_role_id = ? OR recipient_role_id = ?)",
    roleId,
    roleId,
  );
  for (const d of active) reject(ctx, d, actor, 'role-deleted');
  return active.length;
}

// ---------- reads ----------

function toDTO(ctx: Ctx, d: DonationRow): DonationDTO {
  const lines: DonationLineDTO[] = linesOf(ctx, d.id).map((l) => ({
    id: l.id,
    assetType: l.asset_type,
    itemDefId: l.item_def_id,
    entryId: l.entry_id,
    currencyId: l.currency_id,
    name: l.name_snapshot,
    imageUrl: imageUrl(l.image_id),
    quantity: l.asset_type === 'currency' ? formatAmount(l.quantity, l.precision ?? 0) : String(l.quantity),
  }));
  const senderNow = findRole(ctx, d.sender_role_id);
  const recipientNow = findRole(ctx, d.recipient_role_id);
  return {
    id: d.id,
    senderRoleId: d.sender_role_id,
    senderRoleName: senderNow?.name ?? d.sender_role_name,
    recipientRoleId: d.recipient_role_id,
    recipientRoleName: recipientNow?.name ?? d.recipient_role_name,
    createdByUsername: d.created_by_username,
    status: d.status,
    createdAt: d.created_at,
    cancelDeadline: d.cancel_deadline,
    approvalDeadline: d.approval_deadline,
    resolvedAt: d.resolved_at,
    resolvedByUsername: d.resolved_by_username,
    resolutionNote: d.resolution_note,
    lines,
  };
}

export function getDonation(ctx: Ctx, id: string): DonationDTO {
  return toDTO(ctx, requireDonation(ctx, id));
}

/** A player may view a donation only if their role sent it, or received it once it left the countdown. */
export function getDonationForPlayer(ctx: Ctx, actor: Actor, id: string): DonationDTO {
  const d = requireDonation(ctx, id);
  const role = currentRoleOf(ctx, actor.userId);
  const visible = role && (role.id === d.sender_role_id || (role.id === d.recipient_role_id && d.status !== 'countdown'));
  if (!visible) throw notFound('That donation does not exist.');
  return toDTO(ctx, d);
}

export function donationsForRole(ctx: Ctx, roleId: string): { outgoing: DonationDTO[]; incoming: DonationDTO[]; recent: DonationDTO[] } {
  const outgoing = ctx.db
    .all<DonationRow>("SELECT * FROM donations WHERE sender_role_id = ? AND status IN ('countdown', 'pending') ORDER BY created_at", roleId)
    .map((d) => toDTO(ctx, d));
  const incoming = ctx.db
    .all<DonationRow>("SELECT * FROM donations WHERE recipient_role_id = ? AND status = 'pending' ORDER BY approval_deadline", roleId)
    .map((d) => toDTO(ctx, d));
  const recent = ctx.db
    .all<DonationRow>(
      `SELECT * FROM donations
        WHERE (sender_role_id = ? OR (recipient_role_id = ? AND status <> 'cancelled' AND approval_deadline IS NOT NULL) OR (recipient_role_id = ? AND status = 'completed'))
          AND status NOT IN ('countdown', 'pending')
        ORDER BY resolved_at DESC LIMIT 20`,
      roleId,
      roleId,
      roleId,
    )
    .map((d) => toDTO(ctx, d));
  return { outgoing, incoming, recent };
}

export function listDonations(ctx: Ctx, q: { status?: string; roleId?: string; limit?: number; before?: number }): DonationDTO[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (q.status) {
    if (q.status === 'active') where.push("status IN ('countdown', 'pending')");
    else {
      where.push('status = ?');
      params.push(q.status);
    }
  }
  if (q.roleId) {
    where.push('(sender_role_id = ? OR recipient_role_id = ?)');
    params.push(q.roleId, q.roleId);
  }
  if (q.before) {
    where.push('created_at < ?');
    params.push(q.before);
  }
  const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
  return ctx.db
    .all<DonationRow>(`SELECT * FROM donations ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`, ...params, limit)
    .map((d) => toDTO(ctx, d));
}

export function activeDonationCountForRole(ctx: Ctx, roleId: string): number {
  return ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM donations WHERE status IN ('countdown', 'pending') AND (sender_role_id = ? OR recipient_role_id = ?)", roleId, roleId)!.n;
}

