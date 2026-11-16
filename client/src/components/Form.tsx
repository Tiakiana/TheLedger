import { useId, useMemo, useState, type ReactNode } from 'react';
import type { RoleRef } from '../../../server/src/shared/types';
import { Art } from './Art';
import { IconMinus, IconPlus, IconSearch } from './Icons';

export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string | null; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className={`field ${error ? 'field-error' : ''}`}>
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {error ? <div className="field-msg error-text">{error}</div> : hint ? <div className="field-msg">{hint}</div> : null}
    </div>
  );
}

export function SearchBox({ value, onChange, placeholder, autoFocus }: { value: string; onChange: (v: string) => void; placeholder: string; autoFocus?: boolean }) {
  return (
    <div className="search">
      <IconSearch size={18} />
      <input type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} autoFocus={autoFocus} data-autofocus={autoFocus || undefined} />
    </div>
  );
}

/** Whole-number stepper with large touch targets. */
export function QuantityInput({ value, onChange, min = 1, max, disabled, label = 'Quantity', showAll = true }: { value: number; onChange: (n: number) => void; min?: number; max: number; disabled?: boolean; label?: string; showAll?: boolean }) {
  const clamp = (n: number) => Math.max(min, Math.min(max, Math.floor(n)));
  return (
    <div className="qty">
      <button type="button" className="icon-btn qty-btn" onClick={() => onChange(clamp(value - 1))} disabled={disabled || value <= min} aria-label="Decrease">
        <IconMinus size={18} />
      </button>
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={Number.isFinite(value) ? value : ''}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => {
          const n = Number(e.target.value);
          onChange(e.target.value === '' || !Number.isFinite(n) ? min : clamp(n));
        }}
      />
      <button type="button" className="icon-btn qty-btn" onClick={() => onChange(clamp(value + 1))} disabled={disabled || value >= max} aria-label="Increase">
        <IconPlus size={18} />
      </button>
      {showAll && max > min && (
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => onChange(max)} disabled={disabled || value === max}>
          All ({max})
        </button>
      )}
    </div>
  );
}

/** Decimal amount input. Keeps the raw text so there is no float conversion. */
export function AmountInput({ value, onChange, precision, max, invalid, label = 'Amount' }: { value: string; onChange: (v: string) => void; precision: number; max?: string; invalid?: boolean; label?: string }) {
  return (
    <div className="qty">
      <input
        className={`amount-input ${invalid ? 'input-invalid' : ''}`}
        type="text"
        inputMode={precision > 0 ? 'decimal' : 'numeric'}
        value={value}
        placeholder={precision > 0 ? `0.${'0'.repeat(precision)}` : '0'}
        aria-label={label}
        onChange={(e) => onChange(e.target.value.replace(',', '.').replace(/[^\d.]/g, ''))}
      />
      {max !== undefined && (
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => onChange(max)}>
          Max
        </button>
      )}
    </div>
  );
}

/** Searchable list of roles (recipient search). */
export function RolePicker({ roles, value, onChange, autoFocus }: { roles: RoleRef[]; value: string | null; onChange: (id: string) => void; autoFocus?: boolean }) {
  const [q, setQ] = useState('');
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? roles.filter((r) => r.name.toLowerCase().includes(s)) : roles;
  }, [roles, q]);
  return (
    <div className="role-picker">
      <SearchBox value={q} onChange={setQ} placeholder="Search roles by name…" autoFocus={autoFocus} />
      <ul className="role-list" role="listbox" aria-label="Recipient roles">
        {filtered.length === 0 && <li className="muted pad">No roles match “{q}”.</li>}
        {filtered.map((r) => (
          <li key={r.id}>
            <button type="button" role="option" aria-selected={value === r.id} className={`role-option ${value === r.id ? 'selected' : ''}`} onClick={() => onChange(r.id)}>
              <Art url={null} name={r.name} round className="art-xs" />
              <span>{r.name}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Empty({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <h3>{title}</h3>
      {children && <div className="muted">{children}</div>}
    </div>
  );
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="spinner-wrap" role="status">
      <span className="spinner" aria-hidden="true" />
      <span className="muted">{label}</span>
    </div>
  );
}

export function StatusBadge({ status, label }: { status: string; label: string }) {
  return <span className={`badge badge-${status}`}>{label}</span>;
}
