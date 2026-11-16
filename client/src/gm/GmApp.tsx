import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { SessionUser } from '../../../server/src/shared/types';
import { useDebounced, useLive } from '../lib/live';
import { IconBook, IconBox, IconCoins, IconGrid, IconHome, IconKey, IconList, IconLogout, IconSettings, IconTag, IconUsers } from '../components/Icons';
import { PasswordDialog } from '../components/PasswordDialog';
import { useToasts } from '../components/Toasts';
import { LiveDot } from '../player/PlayerApp';
import { emptyCatalog, GmContext, loadCatalog, type Catalog, type GmSection } from './common';
import { Overview } from './Overview';
import { Players } from './Players';
import { Roles } from './Roles';
import { Inventories } from './Inventories';
import { ItemDefinitions } from './ItemDefinitions';
import { Currencies } from './Currencies';
import { Transactions } from './Transactions';
import { Settings } from './Settings';

const SECTIONS: { id: GmSection; label: string; icon: ReactNode }[] = [
  { id: 'overview', label: 'Overview', icon: <IconHome /> },
  { id: 'players', label: 'Players', icon: <IconUsers /> },
  { id: 'roles', label: 'Roles', icon: <IconTag /> },
  { id: 'inventories', label: 'Inventories', icon: <IconGrid /> },
  { id: 'items', label: 'Item Definitions', icon: <IconBox /> },
  { id: 'currencies', label: 'Currencies', icon: <IconCoins /> },
  { id: 'transactions', label: 'Transactions', icon: <IconList /> },
  { id: 'settings', label: 'Settings', icon: <IconSettings /> },
];

function readHash(): GmSection {
  const h = location.hash.replace(/^#\/?/, '').split('/')[0];
  return (SECTIONS.find((s) => s.id === h)?.id ?? 'overview') as GmSection;
}

export function GmApp({ me, onLogout }: { me: SessionUser; onLogout: () => void }) {
  const [section, setSection] = useState<GmSection>(readHash);
  const [version, setVersion] = useState(0);
  const [catalog, setCatalog] = useState<Catalog>(emptyCatalog);
  const [inventoryRoleId, setInventoryRoleId] = useState<string | null>(() => {
    const parts = location.hash.replace(/^#\/?/, '').split('/');
    return parts[0] === 'inventories' && parts[1] ? decodeURIComponent(parts[1]) : null;
  });
  const [showPassword, setShowPassword] = useState(false);
  const toasts = useToasts();

  const reloadCatalog = useCallback(async () => {
    try {
      setCatalog(await loadCatalog());
    } catch (e) {
      toasts.error(e);
    }
  }, [toasts]);

  const bump = useDebounced(() => {
    setVersion((v) => v + 1);
    void reloadCatalog();
  }, 120);

  useEffect(() => {
    void reloadCatalog();
  }, [reloadCatalog]);

  const live = useLive((m) => {
    if (m.type === 'changed' || m.type === 'me-changed') bump();
  });

  useEffect(() => {
    const onHash = () => setSection(readHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const navigate = useCallback((s: GmSection, opts?: { roleId?: string }) => {
    if (opts?.roleId) setInventoryRoleId(opts.roleId);
    setSection(s);
    const hash = s === 'inventories' && opts?.roleId ? `#/inventories/${encodeURIComponent(opts.roleId)}` : `#/${s}`;
    if (location.hash !== hash) history.replaceState(null, '', hash);
    window.scrollTo(0, 0);
  }, []);

  const ctx = useMemo(() => ({ version, catalog, reloadCatalog, navigate, inventoryRoleId }), [version, catalog, reloadCatalog, navigate, inventoryRoleId]);

  return (
    <GmContext.Provider value={ctx}>
      <div className="app app-gm">
        <header className="topbar">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              ℒ
            </span>
            <div className="brand-text">
              <span className="brand-name">The Ledger</span>
              <span className="brand-sub">Gamemaster</span>
            </div>
          </div>
          <div className="topbar-right">
            <LiveDot status={live} />
            <div className="user-chip">
              <IconBook size={16} />
              <span className="user-name">{me.username}</span>
            </div>
            <button className="icon-btn" onClick={() => setShowPassword(true)} aria-label="Change password" title="Change password">
              <IconKey />
            </button>
            <button className="icon-btn" onClick={onLogout} aria-label="Log out" title="Log out">
              <IconLogout />
            </button>
          </div>
        </header>
        <div className="gm-layout">
          <nav className="gm-nav" aria-label="GM sections">
            {SECTIONS.map((s) => (
              <button key={s.id} className={`gm-nav-item ${section === s.id ? 'active' : ''}`} onClick={() => navigate(s.id)} aria-current={section === s.id ? 'page' : undefined}>
                {s.icon}
                <span>{s.label}</span>
              </button>
            ))}
          </nav>
          <main className="gm-main">
            {section === 'overview' && <Overview />}
            {section === 'players' && <Players />}
            {section === 'roles' && <Roles />}
            {section === 'inventories' && <Inventories />}
            {section === 'items' && <ItemDefinitions />}
            {section === 'currencies' && <Currencies />}
            {section === 'transactions' && <Transactions />}
            {section === 'settings' && <Settings />}
          </main>
        </div>
        {showPassword && <PasswordDialog onClose={() => setShowPassword(false)} />}
      </div>
    </GmContext.Provider>
  );
}
