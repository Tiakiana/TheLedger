import type { OverviewDTO } from '../../../server/src/shared/types';
import { serverNow } from '../lib/api';
import { formatTime, mmss, relativeTime } from '../lib/format';
import { useTicker } from '../lib/live';
import { DonationCard } from '../components/DonationCard';
import { Empty, Spinner } from '../components/Form';
import { PageHead, useFetch, useGm, type GmSection } from './common';
import { CategoryBadge } from './Transactions';

export function Overview() {
  const { version, navigate } = useGm();
  const { data, error } = useFetch<OverviewDTO>('/api/gm/overview', version);
  useTicker(1000, !!data && data.activeDonations.length > 0);
  if (!data) return error ? <Empty title="Could not load overview">{error}</Empty> : <Spinner />;
  const now = serverNow();
  const stats: { label: string; value: number; to: GmSection }[] = [
    { label: 'Players', value: data.counts.players, to: 'players' },
    { label: 'Roles', value: data.counts.roles, to: 'roles' },
    { label: 'Item definitions', value: data.counts.itemDefinitions, to: 'items' },
    { label: 'Currencies', value: data.counts.currencies, to: 'currencies' },
    { label: 'Active donations', value: data.counts.activeDonations, to: 'transactions' },
  ];
  return (
    <div className="stack-lg">
      <PageHead title="Overview" subtitle="The state of your campaign's ledger at a glance." />
      <div className="stat-grid">
        {stats.map((s) => (
          <button key={s.label} className="stat" onClick={() => navigate(s.to)}>
            <span className="stat-value">{s.value}</span>
            <span className="stat-label">{s.label}</span>
          </button>
        ))}
      </div>
      <div className="two-col">
        <section className="panel">
          <h2>Server</h2>
          <dl className="facts">
            <dt>Recipient approval</dt>
            <dd>
              <button className="link" onClick={() => navigate('settings')}>
                {data.approvalRequired ? 'Required (5-minute window)' : 'Off: donations complete automatically'}
              </button>
            </dd>
            <dt>Players can connect at</dt>
            <dd>
              {data.lanAddresses.length === 0 ? (
                <span className="muted">{location.origin}</span>
              ) : (
                <ul className="plain">
                  {[location.origin, ...data.lanAddresses.filter((a) => !a.startsWith(location.origin))].map((a) => (
                    <li key={a}>
                      <code>{a}</code>
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </dl>
        </section>
        <section className="panel">
          <h2>Recent activity</h2>
          {data.recentEvents.length === 0 ? (
            <p className="muted">No activity yet.</p>
          ) : (
            <ul className="activity">
              {data.recentEvents.map((e) => (
                <li key={e.id}>
                  <CategoryBadge category={e.category} />
                  <span className="activity-text">{e.summary}</span>
                  <span className="muted small" title={formatTime(e.at)}>
                    {relativeTime(e.at, now)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <button className="btn btn-sm btn-ghost" onClick={() => navigate('transactions')}>
            Full transaction history →
          </button>
        </section>
      </div>
      <section className="stack-sm">
        <h2>Donations in flight</h2>
        {data.activeDonations.length === 0 ? (
          <p className="muted">No donations are currently counting down or awaiting approval.</p>
        ) : (
          <div className="card-grid">
            {data.activeDonations.map((d) => (
              <DonationCard
                key={d.id}
                donation={d}
                perspective="gm"
                aside={<span className="mono">{d.status === 'countdown' ? `${Math.max(0, Math.ceil((d.cancelDeadline - now) / 1000))} s` : mmss((d.approvalDeadline ?? now) - now)}</span>}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
