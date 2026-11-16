import { Fragment, useEffect, useState } from 'react';
import type { AuditEventDTO, DonationDTO } from '../../../server/src/shared/types';
import { errorMessage, get } from '../lib/api';
import { formatDateTime, STATUS_LABEL } from '../lib/format';
import { DonationCard } from '../components/DonationCard';
import { Empty, SearchBox, Spinner } from '../components/Form';
import { IconRefresh } from '../components/Icons';
import { PageHead, useFetch, useGm } from './common';

const CATEGORY_LABEL: Record<AuditEventDTO['category'], string> = {
  donation: 'Donation',
  gm: 'GM operation',
  inventory: 'Inventory',
  auth: 'Sign-in',
  system: 'System',
};

export function CategoryBadge({ category }: { category: AuditEventDTO['category'] }) {
  return <span className={`badge cat-${category}`}>{CATEGORY_LABEL[category]}</span>;
}

interface Filters {
  userId: string;
  roleId: string;
  asset: string; // "item:<id>" | "currency:<id>"
  category: string;
  action: string;
  from: string;
  to: string;
  text: string;
}

const EMPTY: Filters = { userId: '', roleId: '', asset: '', category: '', action: '', from: '', to: '', text: '' };

function toQuery(f: Filters, before?: number | null): string {
  const p = new URLSearchParams();
  if (f.userId) p.set('userId', f.userId);
  if (f.roleId) p.set('roleId', f.roleId);
  if (f.asset) {
    const [type, id] = f.asset.split(':');
    p.set('assetType', type);
    p.set('assetId', id);
  }
  if (f.category) p.set('category', f.category);
  if (f.action) p.set('action', f.action);
  if (f.from) p.set('from', String(new Date(f.from + 'T00:00:00').getTime()));
  if (f.to) p.set('to', String(new Date(f.to + 'T00:00:00').getTime() + 86_400_000));
  if (f.text.trim()) p.set('text', f.text.trim());
  if (before) p.set('before', String(before));
  p.set('limit', '50');
  return p.toString();
}

function AuditLog() {
  const { catalog, version } = useGm();
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [events, setEvents] = useState<AuditEventDTO[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const { data: actions } = useFetch<{ actions: string[] }>('/api/gm/audit/actions', version);
  const set = (k: keyof Filters, v: string) => setFilters((f) => ({ ...f, [k]: v }));

  const load = async (append: boolean) => {
    setLoading(true);
    try {
      const r = await get<{ events: AuditEventDTO[]; nextBefore: number | null }>(`/api/gm/audit?${toQuery(filters, append ? next : null)}`);
      setEvents((prev) => (append ? [...prev, ...r.events] : r.events));
      setNext(r.nextBefore);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  // Reload the first page when filters change or the server reports new activity.
  useEffect(() => {
    const t = window.setTimeout(() => void load(false), filters.text ? 250 : 0);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, version]);

  return (
    <div className="stack">
      <div className="filters">
        <SearchBox value={filters.text} onChange={(v) => set('text', v)} placeholder="Search summaries or transaction IDs…" />
        <select value={filters.userId} onChange={(e) => set('userId', e.target.value)} aria-label="Filter by player">
          <option value="">All players</option>
          {catalog.players.map((p) => (
            <option key={p.id} value={p.id}>
              {p.username}
              {p.isGm ? ' (GM)' : ''}
            </option>
          ))}
        </select>
        <select value={filters.roleId} onChange={(e) => set('roleId', e.target.value)} aria-label="Filter by role">
          <option value="">All roles</option>
          {catalog.roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <select value={filters.asset} onChange={(e) => set('asset', e.target.value)} aria-label="Filter by asset">
          <option value="">All assets</option>
          <optgroup label="Items">
            {catalog.itemDefs.map((d) => (
              <option key={d.id} value={`item:${d.id}`}>
                {d.name}
              </option>
            ))}
          </optgroup>
          <optgroup label="Currencies">
            {catalog.currencies.map((c) => (
              <option key={c.id} value={`currency:${c.id}`}>
                {c.name}
              </option>
            ))}
          </optgroup>
        </select>
        <select value={filters.category} onChange={(e) => set('category', e.target.value)} aria-label="Filter by type">
          <option value="">All types</option>
          <option value="donation">Donations</option>
          <option value="gm">GM operations</option>
          <option value="auth">Sign-ins</option>
          <option value="system">System</option>
        </select>
        <select value={filters.action} onChange={(e) => set('action', e.target.value)} aria-label="Filter by action">
          <option value="">All actions</option>
          {(actions?.actions ?? []).map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <label className="date-filter">
          <span className="small muted">From</span>
          <input type="date" value={filters.from} onChange={(e) => set('from', e.target.value)} />
        </label>
        <label className="date-filter">
          <span className="small muted">To</span>
          <input type="date" value={filters.to} onChange={(e) => set('to', e.target.value)} />
        </label>
        <button className="btn btn-sm btn-ghost" onClick={() => setFilters(EMPTY)} disabled={JSON.stringify(filters) === JSON.stringify(EMPTY)}>
          Clear filters
        </button>
      </div>
      {error && <p className="error-box">{error}</p>}
      {events.length === 0 && !loading ? (
        <Empty title="No matching records" />
      ) : (
        <div className="table-wrap">
          <table className="table audit-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Type</th>
                <th>Actor</th>
                <th>What happened</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <Fragment key={e.id}>
                  <tr className={`clickable ${open === e.id ? 'open' : ''}`} onClick={() => setOpen(open === e.id ? null : e.id)}>
                    <td className="nowrap small">{formatDateTime(e.at)}</td>
                    <td>
                      <CategoryBadge category={e.category} />
                    </td>
                    <td className="nowrap">{e.actorUsername ?? <span className="muted">server</span>}</td>
                    <td>
                      {e.summary}
                      {e.donationId && (
                        <>
                          {' '}
                          <code className="small">{e.donationId}</code>
                        </>
                      )}
                    </td>
                  </tr>
                  {open === e.id && (
                    <tr className="detail-row">
                      <td colSpan={4}>
                        <dl className="facts">
                          <dt>Record</dt>
                          <dd>
                            #{e.id} · <code>{e.action}</code>
                          </dd>
                          {e.roleName && (
                            <>
                              <dt>Role</dt>
                              <dd>{e.roleName}</dd>
                            </>
                          )}
                          {e.counterpartyRoleName && (
                            <>
                              <dt>Other role</dt>
                              <dd>{e.counterpartyRoleName}</dd>
                            </>
                          )}
                          {e.assets.length > 0 && (
                            <>
                              <dt>Assets</dt>
                              <dd>
                                <ul className="plain">
                                  {e.assets.map((a, i) => (
                                    <li key={i}>
                                      {a.quantity ? `${a.quantity} ` : ''}
                                      {a.assetName}
                                      {a.instanceId && <code className="small"> {a.instanceId.slice(0, 8)}</code>}
                                    </li>
                                  ))}
                                </ul>
                              </dd>
                            </>
                          )}
                          {e.details != null && (
                            <>
                              <dt>Details</dt>
                              <dd>
                                <pre className="json">{JSON.stringify(e.details, null, 2)}</pre>
                              </dd>
                            </>
                          )}
                        </dl>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {loading && <Spinner />}
      {next && !loading && (
        <button className="btn" onClick={() => load(true)}>
          Load older records
        </button>
      )}
      <p className="muted small">Records are permanent: they cannot be edited or deleted, and they are kept when players, roles or items are removed.</p>
    </div>
  );
}

function DonationsList() {
  const { catalog, version } = useGm();
  const [status, setStatus] = useState('');
  const [roleId, setRoleId] = useState('');
  const q = new URLSearchParams();
  if (status) q.set('status', status);
  if (roleId) q.set('roleId', roleId);
  q.set('limit', '200');
  const { data, error, reload, loading } = useFetch<{ donations: DonationDTO[] }>(`/api/gm/donations?${q}`, version);
  return (
    <div className="stack">
      <div className="filters">
        <div className="segmented" role="radiogroup" aria-label="Status">
          {['', 'active', 'pending', 'completed', 'cancelled', 'rejected', 'failed'].map((s) => (
            <button key={s} role="radio" aria-checked={status === s} className={status === s ? 'active' : ''} onClick={() => setStatus(s)}>
              {s === '' ? 'All' : s === 'active' ? 'In flight' : STATUS_LABEL[s as DonationDTO['status']]}
            </button>
          ))}
        </div>
        <select value={roleId} onChange={(e) => setRoleId(e.target.value)} aria-label="Filter by role">
          <option value="">All roles</option>
          {catalog.roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <button className="icon-btn" onClick={() => void reload()} aria-label="Refresh" disabled={loading}>
          <IconRefresh size={18} />
        </button>
      </div>
      {error && <p className="error-box">{error}</p>}
      {!data ? (
        <Spinner />
      ) : data.donations.length === 0 ? (
        <Empty title="No donations" />
      ) : (
        <div className="card-grid">
          {data.donations.map((d) => (
            <DonationCard key={d.id} donation={d} perspective="gm" />
          ))}
        </div>
      )}
    </div>
  );
}

export function Transactions() {
  const [tab, setTab] = useState<'audit' | 'donations'>('audit');
  return (
    <div className="stack">
      <PageHead title="Transactions" subtitle="The complete, permanent history of donations and GM operations. Visible only to the GM." />
      <div className="subtabs" role="tablist">
        <button role="tab" aria-selected={tab === 'audit'} className={tab === 'audit' ? 'active' : ''} onClick={() => setTab('audit')}>
          Audit log
        </button>
        <button role="tab" aria-selected={tab === 'donations'} className={tab === 'donations' ? 'active' : ''} onClick={() => setTab('donations')}>
          Donations
        </button>
      </div>
      {tab === 'audit' ? <AuditLog /> : <DonationsList />}
    </div>
  );
}
