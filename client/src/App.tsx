import { useCallback, useEffect, useState } from 'react';
import type { SessionUser } from '../../server/src/shared/types';
import { get, post } from './lib/api';
import { Login } from './Login';
import { PlayerApp } from './player/PlayerApp';
import { GmApp } from './gm/GmApp';
import { Spinner } from './components/Form';

export function App() {
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined);

  const loadMe = useCallback(async () => {
    try {
      const r = await get<{ user: SessionUser | null }>('/api/auth/me');
      setUser(r.user);
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    void loadMe();
    const onUnauthorized = () => setUser(null);
    window.addEventListener('ledger:unauthorized', onUnauthorized);
    return () => window.removeEventListener('ledger:unauthorized', onUnauthorized);
  }, [loadMe]);

  const logout = async () => {
    try {
      await post('/api/auth/logout');
    } finally {
      setUser(null);
    }
  };

  if (user === undefined) return <div className="center-screen"><Spinner /></div>;
  if (user === null) return <Login onLogin={setUser} />;
  return user.isGm ? <GmApp me={user} onLogout={logout} /> : <PlayerApp key={user.id} me={user} onLogout={logout} />;
}
