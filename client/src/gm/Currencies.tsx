import { useState } from 'react';
import type { CurrencyDTO, GaugeStyle } from '../../../server/src/shared/types';
import { del, errorMessage, patch, post } from '../lib/api';
import { isValidAmount } from '../lib/decimal';
import { prettyAmount } from '../lib/format';
import { Art } from '../components/Art';
import { Empty, Field } from '../components/Form';
import { Gauge } from '../components/Gauge';
import { IconEdit, IconPlus, IconTrash } from '../components/Icons';
import { ConfirmDialog, Modal } from '../components/Modal';
import { useToasts } from '../components/Toasts';
import { PageHead, useFetch, useGm } from './common';
import { ImagePicker } from './ItemDefinitions';
import { TransferDialog } from './Inventories';

function CurrencyDialog({ currency, onClose }: { currency: CurrencyDTO | null; onClose: () => void }) {
  const [name, setName] = useState(currency?.name ?? '');
  const [precision, setPrecision] = useState(currency?.precision ?? 0);
  const [min, setMin] = useState(currency?.min ?? '');
  const [max, setMax] = useState(currency?.max ?? '');
  const [gauge, setGauge] = useState<GaugeStyle>(currency?.gauge ?? 'none');
  const [color, setColor] = useState(currency?.color ?? '#b07d2b');
  const [icon, setIcon] = useState<{ id: string | null; url: string | null }>({ id: currency?.iconImageId ?? null, url: currency?.iconUrl ?? null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toasts = useToasts();
  const limitOk = (v: string) => v === '' || isValidAmount(v, precision);
  const preview: CurrencyDTO = { id: 'preview', name: name || 'Preview', iconImageId: icon.id, iconUrl: icon.url, precision, min: min || null, max: max || null, gauge, color, position: 0 };
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { name, precision, min: min === '' ? null : min, max: max === '' ? null : max, gauge, color, iconImageId: icon.id };
      if (currency) await patch(`/api/gm/currencies/${currency.id}`, body);
      else await post('/api/gm/currencies', body);
      toasts.show(currency ? `Saved ${name}.` : `Created ${name}.`, 'success');
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={currency ? `Edit ${currency.name}` : 'New currency or resource'}
      onClose={onClose}
      size="lg"
      locked={busy}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={busy || !name.trim() || !limitOk(min) || !limitOk(max)}>
            {busy ? 'Saving…' : currency ? 'Save' : 'Create'}
          </button>
        </>
      }
    >
      <div className="currency-form">
        <div className="stack">
          <ImagePicker imageId={icon.id} imageUrl={icon.url} name={name} round onChange={(id, url) => setIcon({ id, url })} />
          <Field label="Name" hint="e.g. Gold, Political power, Influence, Prestige.">
            {(id) => <input id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={40} data-autofocus />}
          </Field>
          <Field label="Decimal places" hint="0 for whole numbers. Raising this later is always safe.">
            {(id) => (
              <select id={id} value={precision} onChange={(e) => setPrecision(Number(e.target.value))}>
                {[0, 1, 2, 3, 4, 5, 6].map((p) => (
                  <option key={p} value={p}>
                    {p === 0 ? '0 (integer)' : `${p} (e.g. ${(1).toFixed(p)})`}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <div className="row-tight">
            <Field label="Minimum" hint="Optional; at most 0. Blank means 0." error={limitOk(min) ? null : 'Invalid number'}>
              {(id) => <input id={id} value={min} onChange={(e) => setMin(e.target.value.trim())} inputMode="decimal" placeholder="0" />}
            </Field>
            <Field label="Maximum" hint="Optional. Blank means no maximum." error={limitOk(max) ? null : 'Invalid number'}>
              {(id) => <input id={id} value={max} onChange={(e) => setMax(e.target.value.trim())} inputMode="decimal" placeholder="none" />}
            </Field>
          </div>
        </div>
        <div className="stack">
          <Field label="Gauge" hint="Shown only when a maximum is set.">
            {() => (
              <div className="segmented" role="radiogroup" aria-label="Gauge">
                {(['none', 'bar', 'dial'] as const).map((g) => (
                  <button key={g} type="button" role="radio" aria-checked={gauge === g} className={gauge === g ? 'active' : ''} onClick={() => setGauge(g)}>
                    {g === 'none' ? 'None' : g === 'bar' ? 'Bar' : 'Dial'}
                  </button>
                ))}
              </div>
            )}
          </Field>
          <Field label="Color">{(id) => <input id={id} type="color" value={color} onChange={(e) => setColor(e.target.value)} className="color-input" />}</Field>
          <div className="preview-box">
            <span className="muted small">Preview at 60% of maximum</span>
            <div className="row-tight">
              <Art url={icon.url} name={preview.name} round className="art-sm" />
              <strong>{preview.name}</strong>
            </div>
            {max && isValidAmount(max, precision) ? <Gauge currency={preview} amount={previewAmount(min || '0', max, precision)} /> : <span className="muted small">No maximum: balances show as plain numbers.</span>}
          </div>
        </div>
      </div>
      {error && <p className="error-box">{error}</p>}
    </Modal>
  );
}

function previewAmount(min: string, max: string, precision: number): string {
  const lo = Number(min) || 0;
  const hi = Number(max) || 0;
  return (lo + (hi - lo) * 0.6).toFixed(precision);
}

function BalancesDialog({ currency, onClose }: { currency: CurrencyDTO; onClose: () => void }) {
  const { version, navigate } = useGm();
  const { data } = useFetch<{ balances: { roleId: string; roleName: string; amount: string; reserved: string }[] }>(`/api/gm/currencies/${currency.id}/balances`, version);
  return (
    <Modal title={`${currency.name} across roles`} onClose={onClose}>
      {!data ? (
        <p className="muted">Loading…</p>
      ) : data.balances.length === 0 ? (
        <p className="muted">No roles yet.</p>
      ) : (
        <table className="table table-cards">
          <thead>
            <tr>
              <th>Role</th>
              <th className="num">Balance</th>
              <th className="num">Reserved</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {data.balances.map((b) => (
              <tr key={b.roleId}>
                <td>{b.roleName}</td>
                <td className="num mono">{prettyAmount(b.amount)}</td>
                <td className="num mono muted">{/^0(\.0+)?$/.test(b.reserved) ? '–' : prettyAmount(b.reserved)}</td>
                <td className="actions">
                  <button className="btn btn-sm" onClick={() => navigate('inventories', { roleId: b.roleId })}>
                    Open
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

export function Currencies() {
  const { catalog } = useGm();
  const [editing, setEditing] = useState<CurrencyDTO | null | 'new'>(null);
  const [viewing, setViewing] = useState<CurrencyDTO | null>(null);
  const [transferring, setTransferring] = useState<CurrencyDTO | null>(null);
  const [deleting, setDeleting] = useState<CurrencyDTO | null>(null);
  const [busy, setBusy] = useState(false);
  const toasts = useToasts();
  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await del(`/api/gm/currencies/${deleting.id}`);
      toasts.show(`Deleted ${deleting.name}.`, 'info');
      setDeleting(null);
    } catch (e) {
      toasts.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      <PageHead title="Currencies" subtitle="Money, resources and abstract values such as influence or prestige. Amounts are exact decimals.">
        <button className="btn btn-primary" onClick={() => setEditing('new')}>
          <IconPlus size={18} /> New currency
        </button>
      </PageHead>
      {catalog.currencies.length === 0 ? (
        <Empty title="No currencies yet">Define money, gold, political power, influence or any other resource.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Currency</th>
                <th>Decimals</th>
                <th>Range</th>
                <th className="hide-sm">Gauge</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {catalog.currencies.map((c) => (
                <tr key={c.id}>
                  <td>
                    <div className="row-tight">
                      <Art url={c.iconUrl} name={c.name} round className="art-xs" />
                      <strong>{c.name}</strong>
                      <span className="swatch" style={{ background: c.color }} aria-hidden="true" />
                    </div>
                  </td>
                  <td>{c.precision}</td>
                  <td className="mono small">
                    {c.min ?? '0'} … {c.max ?? '∞'}
                  </td>
                  <td className="hide-sm">{c.gauge === 'none' ? '–' : c.gauge}</td>
                  <td className="actions">
                    <button className="btn btn-sm" onClick={() => setViewing(c)}>
                      Balances
                    </button>
                    <button className="btn btn-sm hide-sm" onClick={() => setTransferring(c)} disabled={catalog.roles.length < 2}>
                      Transfer
                    </button>
                    <button className="icon-btn" onClick={() => setEditing(c)} aria-label={`Edit ${c.name}`}>
                      <IconEdit size={18} />
                    </button>
                    <button className="icon-btn danger" onClick={() => setDeleting(c)} aria-label={`Delete ${c.name}`}>
                      <IconTrash size={18} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <CurrencyDialog currency={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {viewing && <BalancesDialog currency={viewing} onClose={() => setViewing(null)} />}
      {transferring && <TransferDialog currency={transferring} onClose={() => setTransferring(null)} />}
      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          danger
          busy={busy}
          confirmLabel="Delete currency"
          message="Every role's balance of this currency is removed. The transaction history is kept."
          onConfirm={remove}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
