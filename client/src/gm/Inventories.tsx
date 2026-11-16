import { useEffect, useMemo, useState } from 'react';
import type { CurrencyDTO, DonationDTO, EntryDTO, InventoryDTO, ItemDefDTO } from '../../../server/src/shared/types';
import { del, errorMessage, patch, post } from '../lib/api';
import { isValidAmount } from '../lib/decimal';
import { prettyAmount } from '../lib/format';
import { Art } from '../components/Art';
import { CurrencyCard } from '../components/CurrencyCard';
import { DonationCard } from '../components/DonationCard';
import { AmountInput, Empty, Field, QuantityInput, SearchBox, Spinner } from '../components/Form';
import { IconArrowRight, IconBox, IconPlus, IconTrash } from '../components/Icons';
import { InventoryGrid, useSortMode } from '../components/InventoryGrid';
import { ConfirmDialog, Modal } from '../components/Modal';
import { useToasts } from '../components/Toasts';
import { ItemFacts } from '../player/InventoryView';
import { PageHead, useFetch, useGm } from './common';

interface GmInventoryResponse {
  inventory: InventoryDTO;
  outgoing: DonationDTO[];
  incoming: DonationDTO[];
  recent: DonationDTO[];
}

export function Inventories() {
  const { version, catalog, inventoryRoleId, navigate } = useGm();
  const roleId = inventoryRoleId && catalog.roles.some((r) => r.id === inventoryRoleId) ? inventoryRoleId : (catalog.roles[0]?.id ?? null);
  const { data, error } = useFetch<GmInventoryResponse>(roleId ? `/api/gm/roles/${roleId}/inventory` : null, version);
  const [sort, setSort] = useSortMode('ledger.sort.gm');
  const [moving, setMoving] = useState<EntryDTO | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [adjusting, setAdjusting] = useState<CurrencyDTO | null>(null);
  const [transferring, setTransferring] = useState<CurrencyDTO | null>(null);
  const toasts = useToasts();

  useEffect(() => {
    setMoving(null);
    setDetailId(null);
  }, [roleId]);

  if (catalog.roles.length === 0) {
    return (
      <div className="stack">
        <PageHead title="Inventories" />
        <Empty title="No roles yet">
          <button className="btn btn-primary" onClick={() => navigate('roles')}>
            Create a role
          </button>
        </Empty>
      </div>
    );
  }

  const inv = data?.inventory && data.inventory.role.id === roleId ? data.inventory : null;
  const detail = inv?.entries.find((e) => e.id === detailId) ?? null;
  const role = catalog.roles.find((r) => r.id === roleId);
  const inFlight = data ? [...data.outgoing, ...data.incoming] : [];

  return (
    <div className="stack gm-inventory">
      <PageHead title="Inventories" subtitle="Open and edit any role's inventory. Changes appear live for its players.">
        <select className="role-select" value={roleId ?? ''} onChange={(e) => navigate('inventories', { roleId: e.target.value })} aria-label="Choose role">
          {catalog.roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </PageHead>
      {role && (
        <p className="muted small">
          Controlled by: {role.players.length ? role.players.map((p) => p.username).join(', ') : 'no players'}
        </p>
      )}
      {!inv ? (
        error ? <Empty title="Could not load inventory">{error}</Empty> : <Spinner />
      ) : (
        <>
          <div className="gm-inv-grid">
            <InventoryGrid
              entries={inv.entries}
              sort={sort}
              onSortChange={setSort}
              onOpen={(e) => setDetailId(e.id)}
              onReorder={async (entryId, beforeEntryId) => {
                try {
                  await post(`/api/gm/roles/${inv.role.id}/reorder`, { entryId, beforeEntryId });
                } catch (e) {
                  toasts.error(e);
                  throw e;
                }
              }}
              moving={moving}
              onMovingChange={setMoving}
              toolbarExtra={
                <button className="btn btn-primary" onClick={() => setAdding(true)} disabled={catalog.itemDefs.length === 0} title={catalog.itemDefs.length === 0 ? 'Create an item definition first' : undefined}>
                  <IconPlus size={18} /> Add item
                </button>
              }
              emptyState={
                <Empty title="Empty inventory" icon={<IconBox size={32} />}>
                  {catalog.itemDefs.length === 0 ? 'Create item definitions first, then add them here.' : 'Use “Add item” to give this role items.'}
                </Empty>
              }
            />
          </div>
          <section className="stack-sm">
            <h2>Resources</h2>
            {inv.currencies.length === 0 ? (
              <p className="muted">
                No currencies defined.{' '}
                <button className="link" onClick={() => navigate('currencies')}>
                  Define one
                </button>
              </p>
            ) : (
              <div className="currency-grid">
                {inv.currencies.map((c) => (
                  <CurrencyCard
                    key={c.id}
                    currency={c}
                    balance={inv.balances.find((b) => b.currencyId === c.id)}
                    actions={
                      <>
                        <button className="btn btn-sm btn-primary" onClick={() => setAdjusting(c)}>
                          Adjust
                        </button>
                        <button className="btn btn-sm" onClick={() => setTransferring(c)} disabled={catalog.roles.length < 2}>
                          Transfer
                        </button>
                      </>
                    }
                  />
                ))}
              </div>
            )}
          </section>
          {inFlight.length > 0 && (
            <section className="stack-sm">
              <h2>Donations in flight</h2>
              <div className="card-grid">
                {inFlight.map((d) => (
                  <DonationCard key={d.id} donation={d} perspective="gm" />
                ))}
              </div>
            </section>
          )}
        </>
      )}
      {adding && inv && <AddItemDialog roleId={inv.role.id} roleName={inv.role.name} defs={catalog.itemDefs} onClose={() => setAdding(false)} />}
      {detail && inv && <GmEntryDialog entry={detail} roleId={inv.role.id} onClose={() => setDetailId(null)} onMove={() => (setDetailId(null), setMoving(detail))} canArrange={sort === 'custom'} />}
      {adjusting && inv && <AdjustBalanceDialog inventory={inv} currency={adjusting} onClose={() => setAdjusting(null)} />}
      {transferring && inv && <TransferDialog fromRoleId={inv.role.id} currency={transferring} onClose={() => setTransferring(null)} />}
    </div>
  );
}

function AddItemDialog({ roleId, roleName, defs, onClose }: { roleId: string; roleName: string; defs: ItemDefDTO[]; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [defId, setDefId] = useState<string | null>(null);
  const [qty, setQty] = useState(1);
  const [customName, setCustomName] = useState('');
  const [customDescription, setCustomDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toasts = useToasts();
  const def = defs.find((d) => d.id === defId) ?? null;
  const filtered = useMemo(() => defs.filter((d) => !q.trim() || d.name.toLowerCase().includes(q.trim().toLowerCase())), [defs, q]);
  const submit = async () => {
    if (!def) return;
    setBusy(true);
    setError(null);
    try {
      await post(`/api/gm/roles/${roleId}/items`, { itemDefId: def.id, quantity: qty, customName: def.stackable ? undefined : customName || null, customDescription: def.stackable ? undefined : customDescription || null });
      toasts.show(`Added ${qty}× ${customName || def.name} to ${roleName}.`, 'success');
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Add item to ${roleName}`}
      onClose={onClose}
      size="lg"
      locked={busy}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={!def || busy}>
            {busy ? 'Adding…' : 'Add to inventory'}
          </button>
        </>
      }
    >
      <div className="stack">
        <SearchBox value={q} onChange={setQ} placeholder="Search item definitions…" autoFocus />
        <ul className="def-pick">
          {filtered.map((d) => (
            <li key={d.id}>
              <button type="button" className={`def-option ${defId === d.id ? 'selected' : ''}`} onClick={() => setDefId(d.id)} aria-pressed={defId === d.id}>
                <Art url={d.imageUrl} name={d.name} className="art-sm" />
                <span>
                  <strong>{d.name}</strong>
                  <span className="muted small">{d.stackable ? 'Stackable' : 'Unique'}</span>
                </span>
              </button>
            </li>
          ))}
          {filtered.length === 0 && <li className="muted pad">No definitions match.</li>}
        </ul>
        {def && (
          <div className="stack-sm">
            <Field label={def.stackable ? 'Quantity' : 'Number of unique instances'}>{() => <QuantityInput value={qty} onChange={setQty} max={def.stackable ? 1_000_000 : 100} showAll={false} />}</Field>
            {!def.stackable && (
              <>
                <Field label="Custom name (optional)" hint={`e.g. a land deed named after its property. Defaults to “${def.name}”.`}>
                  {(id) => <input id={id} value={customName} onChange={(e) => setCustomName(e.target.value)} maxLength={80} />}
                </Field>
                <Field label="Custom description (optional)">{(id) => <textarea id={id} rows={2} value={customDescription} onChange={(e) => setCustomDescription(e.target.value)} />}</Field>
              </>
            )}
          </div>
        )}
        {error && <p className="error-box">{error}</p>}
      </div>
    </Modal>
  );
}

function GmEntryDialog({ entry, roleId, onClose, onMove, canArrange }: { entry: EntryDTO; roleId: string; onClose: () => void; onMove: () => void; canArrange: boolean }) {
  const { catalog } = useGm();
  const [qty, setQty] = useState(entry.quantity);
  const [customName, setCustomName] = useState(entry.customName ?? '');
  const [customDescription, setCustomDescription] = useState(entry.customDescription ?? '');
  const [toRole, setToRole] = useState('');
  const [moveQty, setMoveQty] = useState(Math.max(1, entry.available));
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toasts = useToasts();
  const others = catalog.roles.filter((r) => r.id !== roleId);

  const run = async (fn: () => Promise<unknown>, msg: string, close = false) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      toasts.show(msg, 'success');
      if (close) onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={entry.name} onClose={onClose} size="lg" locked={busy}>
      <div className="detail">
        <div className="detail-art">
          <Art url={entry.imageUrl} name={entry.name} />
          {entry.kind === 'stack' && <span className="qty-badge qty-badge-lg">×{entry.quantity}</span>}
        </div>
        <div className="stack">
          {entry.description && <p className="detail-desc">{entry.description}</p>}
          <ItemFacts entry={entry} />
          {entry.kind === 'stack' ? (
            <Field label="Set quantity" hint={entry.reserved ? `Cannot go below ${entry.reserved} (reserved by a donation). 0 removes the stack.` : '0 removes the stack.'}>
              {() => (
                <div className="row-tight">
                  <QuantityInput value={qty} onChange={setQty} min={0} max={1_000_000_000} showAll={false} />
                  <button className="btn btn-primary btn-sm" disabled={busy || qty === entry.quantity} onClick={() => run(() => patch(`/api/gm/entries/${entry.id}`, { quantity: qty }), `Quantity set to ${qty}.`, qty === 0)}>
                    Save
                  </button>
                </div>
              )}
            </Field>
          ) : (
            <div className="stack-sm">
              <Field label="Custom name">{(id) => <input id={id} value={customName} placeholder={entry.defName} onChange={(e) => setCustomName(e.target.value)} maxLength={80} />}</Field>
              <Field label="Custom description">{(id) => <textarea id={id} rows={2} value={customDescription} onChange={(e) => setCustomDescription(e.target.value)} />}</Field>
              <div>
                <button
                  className="btn btn-primary btn-sm"
                  disabled={busy || (customName === (entry.customName ?? '') && customDescription === (entry.customDescription ?? ''))}
                  onClick={() => run(() => patch(`/api/gm/entries/${entry.id}`, { customName: customName || null, customDescription: customDescription || null }), 'Item updated.')}
                >
                  Save details
                </button>
              </div>
            </div>
          )}
          <fieldset className="fieldset">
            <legend>Move to another role</legend>
            <div className="row-tight wrap">
              <select value={toRole} onChange={(e) => setToRole(e.target.value)} aria-label="Destination role">
                <option value="">Choose role…</option>
                {others.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
              {entry.kind === 'stack' && <QuantityInput value={moveQty} onChange={setMoveQty} max={Math.max(1, entry.available)} />}
              <button
                className="btn btn-sm"
                disabled={busy || !toRole || entry.available === 0}
                onClick={() => run(() => post(`/api/gm/entries/${entry.id}/move`, { toRoleId: toRole, quantity: entry.kind === 'stack' ? moveQty : undefined }), `Moved to ${others.find((r) => r.id === toRole)?.name}.`, entry.kind === 'unique' || moveQty >= entry.quantity)}
              >
                <IconArrowRight size={16} /> Move
              </button>
            </div>
          </fieldset>
          {error && <p className="error-box">{error}</p>}
          <div className="row">
            {canArrange && (
              <button className="btn btn-sm" onClick={onMove}>
                Rearrange…
              </button>
            )}
            <span className="spacer" />
            <button className="btn btn-sm btn-danger" onClick={() => setConfirmDelete(true)} disabled={busy || entry.reserved > 0}>
              <IconTrash size={16} /> Remove from inventory
            </button>
          </div>
        </div>
      </div>
      {confirmDelete && (
        <ConfirmDialog
          title="Remove item?"
          danger
          busy={busy}
          confirmLabel="Remove"
          message={
            <>
              Remove {entry.kind === 'stack' ? `all ${entry.quantity} of ` : ''}
              <strong>{entry.name}</strong> from this inventory?
            </>
          }
          onClose={() => setConfirmDelete(false)}
          onConfirm={() => run(() => del(`/api/gm/entries/${entry.id}`), `Removed ${entry.name}.`, true)}
        />
      )}
    </Modal>
  );
}

function AdjustBalanceDialog({ inventory, currency, onClose }: { inventory: InventoryDTO; currency: CurrencyDTO; onClose: () => void }) {
  const balance = inventory.balances.find((b) => b.currencyId === currency.id);
  const [op, setOp] = useState<'add' | 'subtract' | 'set' | 'reset'>('add');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toasts = useToasts();
  const valid = op === 'reset' || (amount !== '' && isValidAmount(amount.replace(/^-/, ''), currency.precision));
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ amount: string }>(`/api/gm/roles/${inventory.role.id}/currencies/${currency.id}`, { op, amount: op === 'reset' ? undefined : amount });
      toasts.show(`${inventory.role.name}'s ${currency.name} is now ${prettyAmount(r.amount)}.`, 'success');
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`${currency.name}: ${inventory.role.name}`}
      onClose={onClose}
      size="sm"
      locked={busy}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={busy || !valid}>
            Apply
          </button>
        </>
      }
    >
      <div className="stack">
        <p>
          Current balance: <strong>{prettyAmount(balance?.amount ?? '0')}</strong>
          {balance && balance.reserved !== '0' && !/^0(\.0+)?$/.test(balance.reserved) && <span className="muted"> ({prettyAmount(balance.reserved)} reserved)</span>}
        </p>
        <div className="segmented" role="radiogroup" aria-label="Operation">
          {(['add', 'subtract', 'set', 'reset'] as const).map((o) => (
            <button key={o} type="button" role="radio" aria-checked={op === o} className={op === o ? 'active' : ''} onClick={() => setOp(o)}>
              {o[0].toUpperCase() + o.slice(1)}
            </button>
          ))}
        </div>
        {op !== 'reset' ? (
          <Field label="Amount" hint={`Precision: ${currency.precision} decimal place(s). Limits: ${currency.min ?? '0'} to ${currency.max ?? 'no maximum'}.`}>
            {() => <AmountInput value={amount} onChange={setAmount} precision={currency.precision} />}
          </Field>
        ) : (
          <p className="muted">Resets the balance to zero (or to the configured minimum).</p>
        )}
        {error && <p className="error-box">{error}</p>}
      </div>
    </Modal>
  );
}

export function TransferDialog({ fromRoleId, currency, onClose }: { fromRoleId?: string; currency: CurrencyDTO; onClose: () => void }) {
  const { catalog } = useGm();
  const [from, setFrom] = useState(fromRoleId ?? '');
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toasts = useToasts();
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await post('/api/gm/currency-transfers', { fromRoleId: from, toRoleId: to, currencyId: currency.id, amount });
      toasts.show(`Transferred ${prettyAmount(amount)} ${currency.name}.`, 'success');
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Transfer ${currency.name}`}
      onClose={onClose}
      size="sm"
      locked={busy}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={busy || !from || !to || from === to || !isValidAmount(amount, currency.precision)}>
            Transfer
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="From">
          {(id) => (
            <select id={id} value={from} onChange={(e) => setFrom(e.target.value)}>
              <option value="">Choose role…</option>
              {catalog.roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="To">
          {(id) => (
            <select id={id} value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="">Choose role…</option>
              {catalog.roles
                .filter((r) => r.id !== from)
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
            </select>
          )}
        </Field>
        <Field label="Amount">{() => <AmountInput value={amount} onChange={setAmount} precision={currency.precision} />}</Field>
        <p className="muted small">GM transfers are immediate and recorded in the transaction history as GM operations.</p>
        {error && <p className="error-box">{error}</p>}
      </div>
    </Modal>
  );
}
