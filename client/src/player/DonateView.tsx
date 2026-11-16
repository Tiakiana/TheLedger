import { useMemo, useRef, useState, type DragEvent } from 'react';
import type { CurrencyDTO, DonationLineInput, EntryDTO, PlayerStateDTO, RoleRef } from '../../../server/src/shared/types';
import { errorMessage, newRequestId, post } from '../lib/api';
import { compare, isValidAmount } from '../lib/decimal';
import { prettyAmount } from '../lib/format';
import { Art } from '../components/Art';
import { AmountInput, Empty, QuantityInput, RolePicker, SearchBox } from '../components/Form';
import { IconArrowLeft, IconGift, IconLock, IconPlus, IconX } from '../components/Icons';
import { DonationCard } from '../components/DonationCard';
import { useToasts } from '../components/Toasts';
import { ApprovalNote } from './QuickDonate';

const ENTRY_MIME = 'application/x-ledger-entry';
const CURRENCY_MIME = 'application/x-ledger-currency';

type Line = { key: string; type: 'item'; entryId: string; quantity: number } | { key: string; type: 'currency'; currencyId: string; amount: string };

/** Workflow B: choose the recipient first, then compose a multi-asset donation. */
export function DonateView({ state, roles, onSent }: { state: PlayerStateDTO; roles: RoleRef[]; onSent: () => void }) {
  const inv = state.inventory!;
  const [recipientId, setRecipientId] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [step, setStep] = useState<'compose' | 'confirm'>('compose');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const requestId = useRef(newRequestId());
  const toasts = useToasts();
  const recipient = roles.find((r) => r.id === recipientId) ?? null;

  const entryById = useMemo(() => new Map(inv.entries.map((e) => [e.id, e])), [inv.entries]);
  const currencyById = useMemo(() => new Map(inv.currencies.map((c) => [c.id, c])), [inv.currencies]);
  const balanceOf = (id: string) => inv.balances.find((b) => b.currencyId === id);

  const addEntry = (e: EntryDTO) => {
    if (e.available <= 0) return;
    setLines((ls) => {
      const existing = ls.find((l) => l.type === 'item' && l.entryId === e.id);
      if (existing) {
        if (e.kind === 'unique') return ls;
        return ls.map((l) => (l === existing && l.type === 'item' ? { ...l, quantity: Math.min(e.available, l.quantity + 1) } : l));
      }
      return [...ls, { key: `i:${e.id}`, type: 'item', entryId: e.id, quantity: 1 }];
    });
  };
  const addCurrency = (c: CurrencyDTO) => {
    setLines((ls) => (ls.some((l) => l.type === 'currency' && l.currencyId === c.id) ? ls : [...ls, { key: `c:${c.id}`, type: 'currency', currencyId: c.id, amount: '' }]));
  };
  const remove = (key: string) => setLines((ls) => ls.filter((l) => l.key !== key));
  const update = (key: string, patch: Partial<{ quantity: number; amount: string }>) => setLines((ls) => ls.map((l) => (l.key === key ? ({ ...l, ...patch } as Line) : l)));

  // Validate lines against the live server state.
  const problems = lines.map((l) => {
    if (l.type === 'item') {
      const e = entryById.get(l.entryId);
      if (!e) return 'No longer in your inventory';
      if (l.quantity > e.available) return `Only ${e.available} available`;
      return null;
    }
    const c = currencyById.get(l.currencyId);
    if (!c) return 'Resource no longer exists';
    if (!isValidAmount(l.amount, c.precision) || compare(l.amount, '0', c.precision) <= 0) return 'Enter an amount';
    if (compare(l.amount, balanceOf(c.id)?.available ?? '0', c.precision) > 0) return `Only ${prettyAmount(balanceOf(c.id)?.available ?? '0')} available`;
    return null;
  });
  const canReview = lines.length > 0 && problems.every((p) => p === null) && !busy;

  const payload = (): DonationLineInput[] =>
    lines.map((l) => (l.type === 'item' ? { type: 'item', entryId: l.entryId, quantity: l.quantity } : { type: 'currency', currencyId: l.currencyId, amount: l.amount.trim() }));

  const review = async () => {
    setBusy(true);
    setError(null);
    try {
      await post('/api/donations/validate', { recipientRoleId: recipientId, lines: payload() });
      setStep('confirm');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await post('/api/donations', { requestId: requestId.current, recipientRoleId: recipientId, lines: payload() });
      toasts.show(`Donation to ${recipient!.name} started. You can cancel for 5 seconds.`, 'info');
      requestId.current = newRequestId();
      setLines([]);
      setStep('compose');
      setRecipientId(null);
      onSent();
    } catch (e) {
      setError(errorMessage(e));
      requestId.current = newRequestId();
      setStep('compose');
    } finally {
      setBusy(false);
    }
  };

  const onDrop = (ev: DragEvent) => {
    ev.preventDefault();
    setDropActive(false);
    const entryId = ev.dataTransfer.getData(ENTRY_MIME);
    const currencyId = ev.dataTransfer.getData(CURRENCY_MIME);
    if (entryId && entryById.get(entryId)) addEntry(entryById.get(entryId)!);
    if (currencyId && currencyById.get(currencyId)) addCurrency(currencyById.get(currencyId)!);
  };

  // ---------- step 1: recipient ----------
  if (!recipient) {
    return (
      <div className="view view-scroll">
        <div className="donate-start">
          <div className="section-head">
            <h2>Who are you donating to?</h2>
            <p className="muted">Donations go to roles. Everyone who controls that role shares what they receive.</p>
          </div>
          {roles.length === 0 ? <Empty title="There are no other roles yet" /> : <RolePicker roles={roles} value={null} onChange={setRecipientId} autoFocus />}
          {state.recent.length > 0 && (
            <section className="stack-sm recent">
              <h3>Recent donations</h3>
              {state.recent.slice(0, 8).map((d) => (
                <DonationCard key={d.id} donation={d} perspective={d.senderRoleId === inv.role.id ? 'sender' : 'recipient'} />
              ))}
            </section>
          )}
        </div>
      </div>
    );
  }

  // ---------- step 3: confirm ----------
  if (step === 'confirm') {
    return (
      <div className="view view-scroll">
        <div className="donate-confirm stack">
          <h2>Confirm donation to {recipient.name}</h2>
          <ul className="confirm-lines">
            {lines.map((l) => {
              const e = l.type === 'item' ? entryById.get(l.entryId) : undefined;
              const c = l.type === 'currency' ? currencyById.get(l.currencyId) : undefined;
              return (
                <li key={l.key}>
                  <Art url={e?.imageUrl ?? c?.iconUrl ?? null} name={e?.name ?? c?.name ?? '?'} round={!!c} className="art-sm" />
                  <span>{l.type === 'item' ? (e?.kind === 'unique' ? e.name : `${l.quantity}× ${e?.name}`) : `${prettyAmount(l.amount)} ${c?.name}`}</span>
                </li>
              );
            })}
          </ul>
          <ApprovalNote approvalRequired={state.approvalRequired} recipient={recipient.name} />
          {error && <p className="error-box">{error}</p>}
          <div className="row">
            <button className="btn" onClick={() => setStep('compose')} disabled={busy}>
              <IconArrowLeft size={18} /> Back
            </button>
            <span className="spacer" />
            <button className="btn btn-donate btn-lg" onClick={confirm} disabled={busy}>
              <IconGift size={18} /> {busy ? 'Reserving…' : `Confirm donation (${lines.length})`}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---------- step 2: compose ----------
  const q = query.trim().toLowerCase();
  const pickable = inv.entries.filter((e) => !q || e.name.toLowerCase().includes(q) || e.defName.toLowerCase().includes(q));
  const inTray = new Set(lines.map((l) => (l.type === 'item' ? l.entryId : l.currencyId)));

  return (
    <div className="view composer">
      <div className="composer-head">
        <button className="btn btn-ghost btn-sm" onClick={() => setRecipientId(null)}>
          <IconArrowLeft size={16} /> Change recipient
        </button>
        <h2>
          Donating to <span className="accent-text">{recipient.name}</span>
        </h2>
      </div>
      <div className="composer-body">
        <section className="picker-pane" aria-label="Your assets">
          <SearchBox value={query} onChange={setQuery} placeholder="Find items to add…" />
          <ul className="pick-list">
            {pickable.length === 0 && <li className="muted pad">No items{q ? ` match “${query}”` : ''}.</li>}
            {pickable.map((e) => (
              <li
                key={e.id}
                className={`pick-row ${e.available <= 0 ? 'disabled' : ''} ${inTray.has(e.id) ? 'in-tray' : ''}`}
                draggable={e.available > 0}
                onDragStart={(ev) => {
                  ev.dataTransfer.setData(ENTRY_MIME, e.id);
                  ev.dataTransfer.effectAllowed = 'copy';
                }}
              >
                <Art url={e.imageUrl} name={e.name} className="art-sm" />
                <span className="pick-name">
                  {e.name}
                  <span className="muted small">{e.kind === 'unique' ? 'Unique' : `${e.available} available`}</span>
                </span>
                {e.available <= 0 ? (
                  <IconLock size={16} aria-label="Reserved" />
                ) : (
                  <button className="icon-btn add-btn" onClick={() => addEntry(e)} aria-label={`Add ${e.name}`} disabled={e.kind === 'unique' && inTray.has(e.id)}>
                    <IconPlus size={18} />
                  </button>
                )}
              </li>
            ))}
            {inv.currencies.length > 0 && <li className="pick-sep">Resources</li>}
            {inv.currencies.map((c) => {
              const b = balanceOf(c.id);
              const can = !!b && compare(b.available, '0', c.precision) > 0;
              return (
                <li
                  key={c.id}
                  className={`pick-row ${!can ? 'disabled' : ''} ${inTray.has(c.id) ? 'in-tray' : ''}`}
                  draggable={can}
                  onDragStart={(ev) => {
                    ev.dataTransfer.setData(CURRENCY_MIME, c.id);
                    ev.dataTransfer.effectAllowed = 'copy';
                  }}
                >
                  <Art url={c.iconUrl} name={c.name} round className="art-sm" />
                  <span className="pick-name">
                    {c.name}
                    <span className="muted small">{prettyAmount(b?.available ?? '0')} available</span>
                  </span>
                  <button className="icon-btn add-btn" onClick={() => addCurrency(c)} aria-label={`Add ${c.name}`} disabled={!can || inTray.has(c.id)}>
                    <IconPlus size={18} />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <section
          className={`tray-pane ${dropActive ? 'drop-active' : ''}`}
          aria-label="Donation contents"
          onDragOver={(ev) => {
            if (ev.dataTransfer.types.includes(ENTRY_MIME) || ev.dataTransfer.types.includes(CURRENCY_MIME)) {
              ev.preventDefault();
              ev.dataTransfer.dropEffect = 'copy';
              setDropActive(true);
            }
          }}
          onDragLeave={(ev) => {
            if (!(ev.currentTarget as HTMLElement).contains(ev.relatedTarget as Node)) setDropActive(false);
          }}
          onDrop={onDrop}
        >
          <h3>Donation</h3>
          {lines.length === 0 ? (
            <div className="drop-hint">
              <IconGift size={28} />
              <span>Drag items here, or tap + to add them.</span>
            </div>
          ) : (
            <ul className="tray-lines">
              {lines.map((l, i) => {
                const e = l.type === 'item' ? entryById.get(l.entryId) : undefined;
                const c = l.type === 'currency' ? currencyById.get(l.currencyId) : undefined;
                const label = e?.name ?? c?.name ?? 'Unavailable';
                return (
                  <li key={l.key} className={problems[i] ? 'has-problem' : ''}>
                    <Art url={e?.imageUrl ?? c?.iconUrl ?? null} name={label} round={!!c} className="art-sm" />
                    <div className="tray-line-main">
                      <strong>{label}</strong>
                      {l.type === 'item' && e && (e.kind === 'unique' ? <span className="muted small">Unique item</span> : <QuantityInput value={l.quantity} max={Math.max(1, e.available)} onChange={(n) => update(l.key, { quantity: n })} />)}
                      {l.type === 'currency' && c && <AmountInput value={l.amount} precision={c.precision} max={balanceOf(c.id)?.available} onChange={(v) => update(l.key, { amount: v })} invalid={!!problems[i] && l.amount !== ''} />}
                      {problems[i] && <span className="error-text small">{problems[i]}</span>}
                    </div>
                    <button className="icon-btn" onClick={() => remove(l.key)} aria-label={`Remove ${label}`}>
                      <IconX size={18} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
      <div className="composer-foot">
        {error && <p className="error-box">{error}</p>}
        <span className="muted small">
          {lines.length} {lines.length === 1 ? 'line' : 'lines'} · sent as one transaction
        </span>
        <span className="spacer" />
        <button className="btn btn-donate btn-lg" onClick={review} disabled={!canReview}>
          {busy ? 'Checking…' : 'Review donation'}
        </button>
      </div>
    </div>
  );
}
