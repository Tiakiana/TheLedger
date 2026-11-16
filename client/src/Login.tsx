import { useState, type FormEvent } from 'react';
import type { SessionUser } from '../../server/src/shared/types';
import { errorMessage, post } from './lib/api';
import { Field } from './components/Form';

export function Login({ onLogin }: { onLogin: (u: SessionUser) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ user: SessionUser }>('/api/auth/login', { username: username.trim(), password });
      onLogin(r.user);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <span className="brand-mark brand-mark-lg" aria-hidden="true">
            ℒ
          </span>
          <h1>The Ledger</h1>
          <p className="muted">Inventories and donations for your campaign</p>
        </div>
        <Field label="Username">{(id) => <input id={id} autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />}</Field>
        <Field label="Password">{(id) => <input id={id} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
        {error && <p className="error-box">{error}</p>}
        <button className="btn btn-primary btn-lg btn-block" disabled={busy || !username || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="muted small center">Your account is issued by the Gamemaster.</p>
      </form>
    </div>
  );
}
