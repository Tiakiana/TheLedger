import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { CurrencyDTO, ItemDefDTO, PlayerAdminDTO, RoleAdminDTO } from '../../../server/src/shared/types';
import { errorMessage, get } from '../lib/api';

export type GmSection = 'overview' | 'players' | 'roles' | 'inventories' | 'items' | 'currencies' | 'transactions' | 'settings';

export interface Catalog {
  roles: RoleAdminDTO[];
  players: PlayerAdminDTO[];
  itemDefs: ItemDefDTO[];
  currencies: CurrencyDTO[];
}

export interface GmContextValue {
  /** Increments whenever the server reports a change; views refetch on it. */
  version: number;
  catalog: Catalog;
  reloadCatalog: () => Promise<void>;
  navigate: (section: GmSection, opts?: { roleId?: string }) => void;
  inventoryRoleId: string | null;
}

export const GmContext = createContext<GmContextValue>(null as unknown as GmContextValue);
export const useGm = () => useContext(GmContext);

export const emptyCatalog: Catalog = { roles: [], players: [], itemDefs: [], currencies: [] };

export async function loadCatalog(): Promise<Catalog> {
  const [roles, players, itemDefs, currencies] = await Promise.all([
    get<{ roles: RoleAdminDTO[] }>('/api/gm/roles'),
    get<{ players: PlayerAdminDTO[] }>('/api/gm/players'),
    get<{ itemDefinitions: ItemDefDTO[] }>('/api/gm/item-definitions'),
    get<{ currencies: CurrencyDTO[] }>('/api/gm/currencies'),
  ]);
  return { roles: roles.roles, players: players.players, itemDefs: itemDefs.itemDefinitions, currencies: currencies.currencies };
}

/** Fetches a URL and refetches whenever `version` changes (live updates) or the URL changes. */
export function useFetch<T>(url: string | null, version: number): { data: T | null; error: string | null; loading: boolean; reload: () => Promise<void> } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const current = useRef(url);
  current.current = url;
  const reload = useCallback(async () => {
    if (!url) return;
    setLoading(true);
    try {
      const r = await get<T>(url);
      if (current.current === url) {
        setData(r);
        setError(null);
      }
    } catch (e) {
      if (current.current === url) setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [url]);
  useEffect(() => {
    if (!url) setData(null);
    void reload();
  }, [reload, version, url]);
  return { data, error, loading, reload };
}

export function PageHead({ title, subtitle, children }: { title: string; subtitle?: string; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {children && <div className="page-actions">{children}</div>}
    </div>
  );
}
