import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { CurrencyDTO, EntryDTO, PlayerStateDTO, RoleRef, SessionUser } from '../../../server/src/shared/types';
import { get } from '../lib/api';
import { useDebounced, useLive, type LiveStatus } from '../lib/live';
import { Spinner, Empty } from '../components/Form';
import { IconCoins, IconGift, IconGrid, IconInbox, IconLogout, IconKey } from '../components/Icons';
import { useToasts } from '../components/Toasts';
import { PasswordDialog } from '../components/PasswordDialog';
import { InventoryView } from './InventoryView';
import { ResourcesView } from './ResourcesView';
import { DonateView } from './DonateView';
import { PendingView } from './PendingView';
import { QuickDonate, type QuickTarget } from './QuickDonate';
import { CountdownTray } from './CountdownTray';

export type PlayerTab = 'inventory' | 'resources' | 'donate' | 'pending';

export function LiveDot({ status }: { status: LiveStatus }) {
  const text = status === 'live' ? 'Live' : status === 'connecting' ? 'Connecting…' : 'Reconnecting…';
  return (
    <span className={`live-dot live-${status}`} title={status === 'live' ? 'Receiving live updates' : 'Live updates paused; reconnecting'}>
      <span className="dot" aria-hidden="true" />
      <span className="live-text">{text}</span>
    </span>
  );
}

export function PlayerApp({ me, onLogout }: { me: SessionUser; onLogout: () => void }) {
  const [state, setState] = useState<PlayerStateDTO | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [roles, setRoles] = useState<RoleRef[]>([]);
  const [tab, setTab] = useState<PlayerTab>('inventory');
  const [quick, setQuick] = useState<QuickTarget | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const toasts = useToasts();

  const refresh = useCallback(async () => {
    try {
      const s = await get<PlayerStateDTO>('/api/me/state');
      setState(s);
      setLoadError(null);
      if (s.me.roleId) {
        const d = await get<{ roles: RoleRef[] }>('/api/roles/directory');
        setRoles(d.roles);
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  const refreshSoon = useDebounced(refresh, 60);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const live = useLive((m) => {
    if (m.type === 'changed' || m.type === 'me-changed') refreshSoon();
    if (m.type === 'notify') {
      refreshSoon();
      if (m.kind === 'donation-pending') toasts.show(m.text, 'warning', { label: 'Review', onClick: () => setTab('pending') });
      else toasts.show(m.text, m.kind === 'donation-completed' ? 'success' : m.kind === 'donation-failed' ? 'error' : 'info');
    }
  });

  if (!state) {
    return <div className="center-screen">{loadError ? <Empty title="Could not load your inventory">{loadError}</Empty> : <Spinner label="Opening your ledger…" />}</div>;
  }

  const user = state.me ?? me;
  const inv = state.inventory;
  const pendingCount = state.incoming.length;
  const showPending = state.approvalRequired || pendingCount > 0 || state.outgoing.some((d) => d.status === 'pending');

  const openQuickItem = (entry: EntryDTO) => setQuick({ kind: 'item', entryId: entry.id });
  const openQuickCurrency = (c: CurrencyDTO) => setQuick({ kind: 'currency', currencyId: c.id });

  const tabs: { id: PlayerTab; label: string; icon: ReactNode; badge?: number; hidden?: boolean }[] = [
    { id: 'inventory', label: 'My Inventory', icon: <IconGrid /> },
    { id: 'resources', label: 'Resources', icon: <IconCoins /> },
    { id: 'donate', label: 'Donate', icon: <IconGift /> },
    { id: 'pending', label: 'Pending', icon: <IconInbox />, badge: pendingCount, hidden: !showPending },
  ];

  return (
    <div className="app app-player">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            ℒ
          </span>
          <div className="brand-text">
            <span className="brand-name">The Ledger</span>
            <span className="brand-sub">{inv ? inv.role.name : 'No role assigned'}</span>
          </div>
        </div>
        <div className="topbar-right">
          <LiveDot status={live} />
          {inv && (
            <button className="btn btn-donate" onClick={() => setTab('donate')}>
              <IconGift size={18} /> <span>Donate</span>
            </button>
          )}
          <div className="user-chip" title={state.members.length > 1 ? `Shared with ${state.members.filter((m) => m !== user.username).join(', ')}` : undefined}>
            <span className="user-name">{user.username}</span>
            {state.members.length > 1 && <span className="muted small">+{state.members.length - 1} sharing</span>}
          </div>
          <button className="icon-btn" onClick={() => setShowPassword(true)} aria-label="Change password" title="Change password">
            <IconKey />
          </button>
          <button className="icon-btn" onClick={onLogout} aria-label="Log out" title="Log out">
            <IconLogout />
          </button>
        </div>
      </header>

      {!inv ? (
        <main className="main">
          <Empty title={`Welcome, ${user.username}`} icon={<IconInbox size={36} />}>
            You are not assigned to a role yet. The GM can assign you one; this page updates automatically when that happens.
          </Empty>
        </main>
      ) : (
        <>
          <nav className="tabs" aria-label="Sections">
            {tabs
              .filter((t) => !t.hidden)
              .map((t) => (
                <button key={t.id} className={`tab ${tab === t.id ? 'active' : ''} ${t.id === 'donate' ? 'tab-donate' : ''}`} onClick={() => setTab(t.id)} aria-current={tab === t.id ? 'page' : undefined}>
                  {t.icon}
                  <span className="tab-label">{t.label}</span>
                  {!!t.badge && <span className="tab-badge">{t.badge}</span>}
                </button>
              ))}
          </nav>
          <main className="main">
            {tab === 'inventory' && <InventoryView state={state} userId={user.id} onDonate={openQuickItem} onShowResources={() => setTab('resources')} />}
            {tab === 'resources' && <ResourcesView inventory={inv} onDonate={openQuickCurrency} />}
            {tab === 'donate' && <DonateView state={state} roles={roles} onSent={() => void refresh()} />}
            {tab === 'pending' && <PendingView state={state} onChanged={() => void refresh()} />}
          </main>
          <CountdownTray donations={state.outgoing} onChanged={() => void refresh()} onOpenPending={() => setTab('pending')} />
        </>
      )}

      {quick && inv && <QuickDonate target={quick} state={state} roles={roles} onClose={() => setQuick(null)} onSent={() => void refresh()} />}
      {showPassword && <PasswordDialog onClose={() => setShowPassword(false)} />}
    </div>
  );
}
