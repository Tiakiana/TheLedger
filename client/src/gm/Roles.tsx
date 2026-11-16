import { useMemo, useState } from 'react';
import type { RoleAdminDTO } from '../../../server/src/shared/types';
import { del, errorMessage, patch, post } from '../lib/api';
import { Art } from '../components/Art';
import { Empty, Field, SearchBox } from '../components/Form';
import { IconCopy, IconEdit, IconGrid, IconPlus, IconTrash } from '../components/Icons';
import { Modal } from '../components/Modal';
import { useToasts } from '../components/Toasts';
import { PageHead, useGm } from './common';

function copyName(name: string, taken: string[]): string {
  const stem = name.replace(/ \(copy(?: \d+)?\)$/i, '');
  const lower = new Set(taken.map((t) => t.toLowerCase()));
  for (let i = 1; ; i++) {
    const candidate = `${stem} (copy${i === 1 ? '' : ' ' + i})`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
}

function NameDialog({ title, initial, confirmLabel, onSubmit, onClose }: { title: string; initial: string; confirmLabel: string; onSubmit: (name: string) => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(name.trim());
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={title}
      onClose={onClose}
      size="sm"
      locked={busy}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={busy || !name.trim()}>
            {confirmLabel}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Role name" error={error} hint="For example a character, noble house, kingdom or faction.">
          {(id) => <input id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} data-autofocus />}
        </Field>
      </form>
    </Modal>
  );
}

function DeleteRole({ role, onClose }: { role: RoleAdminDTO; onClose: () => void }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toasts = useToasts();
  const matches = typed.trim().toLowerCase() === role.name.toLowerCase();
  const submit = async () => {
    setBusy(true);
    try {
      await del(`/api/gm/roles/${role.id}`, { confirmName: typed });
      toasts.show(`Deleted ${role.name}.`, 'info');
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Delete ${role.name}?`}
      onClose={onClose}
      size="sm"
      locked={busy}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-danger" onClick={submit} disabled={busy || !matches}>
            {busy ? 'Deleting…' : 'Delete role permanently'}
          </button>
        </>
      }
    >
      <div className="stack">
        <p>This permanently deletes the role and its entire inventory ({role.entryCount} entries and all currency balances).</p>
        <ul className="plain small">
          {role.players.length > 0 && <li>• {role.players.map((p) => p.username).join(', ')} will become unassigned.</li>}
          {role.activeDonations > 0 && <li>• {role.activeDonations} in-flight donation(s) will be cancelled and their assets returned.</li>}
          <li>• The transaction history is kept.</li>
        </ul>
        <Field label={`Type “${role.name}” to confirm`} error={error}>
          {(id) => <input id={id} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" data-autofocus />}
        </Field>
      </div>
    </Modal>
  );
}

export function Roles() {
  const { catalog, navigate } = useGm();
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<RoleAdminDTO | null>(null);
  const [duplicating, setDuplicating] = useState<RoleAdminDTO | null>(null);
  const [deleting, setDeleting] = useState<RoleAdminDTO | null>(null);
  const toasts = useToasts();
  const roles = useMemo(() => {
    const s = q.trim().toLowerCase();
    return catalog.roles.filter((r) => !s || r.name.toLowerCase().includes(s) || r.players.some((p) => p.username.toLowerCase().includes(s)));
  }, [catalog.roles, q]);

  return (
    <div className="stack">
      <PageHead title="Roles" subtitle="Identities in the game. Each role owns one inventory, shared by every player assigned to it.">
        <button className="btn btn-primary" onClick={() => setCreating(true)}>
          <IconPlus size={18} /> New role
        </button>
      </PageHead>
      <SearchBox value={q} onChange={setQ} placeholder="Search roles or players…" />
      {roles.length === 0 ? (
        <Empty title={q ? 'No roles match' : 'No roles yet'}>{!q && 'Create roles for characters, houses, kingdoms or factions.'}</Empty>
      ) : (
        <div className="card-grid">
          {roles.map((r) => (
            <article key={r.id} className="role-card">
              <header>
                <Art url={null} name={r.name} round className="art-sm" />
                <div>
                  <h3>{r.name}</h3>
                  <span className="muted small">
                    {r.entryCount} {r.entryCount === 1 ? 'entry' : 'entries'}
                    {r.activeDonations > 0 && ` · ${r.activeDonations} donation${r.activeDonations > 1 ? 's' : ''} in flight`}
                  </span>
                </div>
              </header>
              <div className="chips">
                {r.players.length === 0 ? <span className="muted small">No players assigned</span> : r.players.map((p) => <span key={p.id} className="chip">{p.username}</span>)}
              </div>
              <footer className="role-actions">
                <button className="btn btn-sm btn-primary" onClick={() => navigate('inventories', { roleId: r.id })}>
                  <IconGrid size={16} /> Inventory
                </button>
                <button className="btn btn-sm" onClick={() => setRenaming(r)}>
                  <IconEdit size={16} /> Rename
                </button>
                <button className="btn btn-sm" onClick={() => setDuplicating(r)}>
                  <IconCopy size={16} /> Duplicate
                </button>
                <button className="icon-btn danger" onClick={() => setDeleting(r)} aria-label={`Delete ${r.name}`} title="Delete">
                  <IconTrash size={18} />
                </button>
              </footer>
            </article>
          ))}
        </div>
      )}
      {creating && (
        <NameDialog
          title="New role"
          initial=""
          confirmLabel="Create role"
          onClose={() => setCreating(false)}
          onSubmit={async (name) => {
            await post('/api/gm/roles', { name });
            toasts.show(`Created ${name}.`, 'success');
          }}
        />
      )}
      {renaming && (
        <NameDialog
          title={`Rename ${renaming.name}`}
          initial={renaming.name}
          confirmLabel="Rename"
          onClose={() => setRenaming(null)}
          onSubmit={async (name) => {
            await patch(`/api/gm/roles/${renaming.id}`, { name });
          }}
        />
      )}
      {duplicating && (
        <NameDialog
          title={`Duplicate ${duplicating.name}`}
          initial={copyName(duplicating.name, catalog.roles.map((r) => r.name))}
          confirmLabel="Duplicate"
          onClose={() => setDuplicating(null)}
          onSubmit={async (name) => {
            const r = await post<{ role: RoleAdminDTO }>(`/api/gm/roles/${duplicating.id}/duplicate`, { name });
            toasts.show(`Created ${r.role.name} with a full copy of the inventory. Players were not copied.`, 'success');
          }}
        />
      )}
      {deleting && <DeleteRole role={deleting} onClose={() => setDeleting(null)} />}
    </div>
  );
}
