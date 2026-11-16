import { useMemo, useState } from 'react';
import type { PlayerAdminDTO } from '../../../server/src/shared/types';
import { del, errorMessage, patch, post } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { Empty, Field, SearchBox, StatusBadge } from '../components/Form';
import { IconCopy, IconKey, IconPlus, IconRefresh, IconTrash } from '../components/Icons';
import { ConfirmDialog, Modal } from '../components/Modal';
import { useToasts } from '../components/Toasts';
import { PageHead, useGm } from './common';

export function generatePassword(length = 10): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

function PasswordField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Field label="Password" hint="At least 6 characters. Give it to the player privately.">
      {(id) => (
        <div className="row-tight">
          <input id={id} value={value} onChange={(e) => onChange(e.target.value)} autoComplete="new-password" spellCheck={false} />
          <button type="button" className="btn btn-sm" onClick={() => onChange(generatePassword())} title="Generate">
            <IconRefresh size={16} /> Generate
          </button>
          <button type="button" className="icon-btn" onClick={() => navigator.clipboard?.writeText(value)} aria-label="Copy password" disabled={!value}>
            <IconCopy size={16} />
          </button>
        </div>
      )}
    </Field>
  );
}

function CreatePlayer({ onClose }: { onClose: () => void }) {
  const { catalog } = useGm();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState(generatePassword());
  const [roleId, setRoleId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toasts = useToasts();
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await post('/api/gm/players', { username, password, roleId: roleId || null });
      toasts.show(`Created ${username}. Password: ${password}`, 'success');
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="New player account"
      onClose={onClose}
      locked={busy}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={busy || username.trim().length < 2 || password.length < 6}>
            {busy ? 'Creating…' : 'Create player'}
          </button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Username" hint="Letters, digits, dot, dash and underscore.">
          {(id) => <input id={id} value={username} onChange={(e) => setUsername(e.target.value)} autoCapitalize="none" spellCheck={false} data-autofocus />}
        </Field>
        <PasswordField value={password} onChange={setPassword} />
        <Field label="Role (optional)">
          {(id) => (
            <select id={id} value={roleId} onChange={(e) => setRoleId(e.target.value)}>
              <option value="">Unassigned</option>
              {catalog.roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        {error && <p className="error-box">{error}</p>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function ResetPassword({ player, onClose }: { player: PlayerAdminDTO; onClose: () => void }) {
  const [password, setPassword] = useState(generatePassword());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toasts = useToasts();
  const submit = async () => {
    setBusy(true);
    try {
      await post(`/api/gm/players/${player.id}/password`, { password });
      toasts.show(`New password for ${player.username}: ${password}`, 'success');
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Reset password: ${player.username}`}
      onClose={onClose}
      size="sm"
      locked={busy}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={busy || password.length < 6}>
            Set password
          </button>
        </>
      }
    >
      <div className="stack">
        <PasswordField value={password} onChange={setPassword} />
        <p className="muted small">The player is signed out everywhere and must log in with the new password.</p>
        {error && <p className="error-box">{error}</p>}
      </div>
    </Modal>
  );
}

export function Players() {
  const { catalog } = useGm();
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState<PlayerAdminDTO | null>(null);
  const [deleting, setDeleting] = useState<PlayerAdminDTO | null>(null);
  const [busy, setBusy] = useState(false);
  const toasts = useToasts();
  const players = useMemo(() => {
    const s = q.trim().toLowerCase();
    return catalog.players.filter((p) => !p.isGm && (!s || p.username.toLowerCase().includes(s)));
  }, [catalog.players, q]);

  const assign = async (p: PlayerAdminDTO, roleId: string) => {
    try {
      await post(`/api/gm/players/${p.id}/assign`, { roleId: roleId || null });
      toasts.show(roleId ? `${p.username} now controls ${catalog.roles.find((r) => r.id === roleId)?.name}.` : `${p.username} is unassigned.`, 'success');
    } catch (e) {
      toasts.error(e);
    }
  };
  const toggle = async (p: PlayerAdminDTO) => {
    try {
      await patch(`/api/gm/players/${p.id}`, { disabled: !p.disabled });
    } catch (e) {
      toasts.error(e);
    }
  };
  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await del(`/api/gm/players/${deleting.id}`);
      toasts.show(`Deleted ${deleting.username}. Their history remains in the audit log.`, 'info');
      setDeleting(null);
    } catch (e) {
      toasts.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <PageHead title="Players" subtitle="Accounts you issue to players. Each player controls at most one role.">
        <button className="btn btn-primary" onClick={() => setCreating(true)}>
          <IconPlus size={18} /> New player
        </button>
      </PageHead>
      <SearchBox value={q} onChange={setQ} placeholder="Search players by username…" />
      {players.length === 0 ? (
        <Empty title={q ? 'No players match' : 'No players yet'}>{!q && 'Create an account for each player and share the password with them.'}</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table table-cards">
            <thead>
              <tr>
                <th>Username</th>
                <th>Role</th>
                <th>Status</th>
                <th className="hide-sm">Created</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {players.map((p) => (
                <tr key={p.id} className={p.disabled ? 'row-muted' : ''}>
                  <td>
                    <strong>{p.username}</strong>
                  </td>
                  <td>
                    <select value={p.roleId ?? ''} onChange={(e) => assign(p, e.target.value)} aria-label={`Role for ${p.username}`}>
                      <option value="">Unassigned</option>
                      {catalog.roles.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>{p.disabled ? <StatusBadge status="cancelled" label="Disabled" /> : <StatusBadge status="completed" label="Active" />}</td>
                  <td className="hide-sm muted small">{formatDateTime(p.createdAt)}</td>
                  <td className="actions">
                    <button className="btn btn-sm" onClick={() => setResetting(p)} title="Reset password">
                      <IconKey size={16} /> <span className="hide-sm">Password</span>
                    </button>
                    <button className="btn btn-sm" onClick={() => toggle(p)}>
                      {p.disabled ? 'Enable' : 'Disable'}
                    </button>
                    <button className="icon-btn danger" onClick={() => setDeleting(p)} aria-label={`Delete ${p.username}`} title="Delete">
                      <IconTrash size={18} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && <CreatePlayer onClose={() => setCreating(false)} />}
      {resetting && <ResetPassword player={resetting} onClose={() => setResetting(null)} />}
      {deleting && (
        <ConfirmDialog
          title="Delete player account?"
          danger
          busy={busy}
          confirmLabel="Delete account"
          message={
            <>
              <strong>{deleting.username}</strong> will lose access immediately. Their role and its inventory are not affected, and their past actions stay in the transaction history.
            </>
          }
          onConfirm={remove}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
