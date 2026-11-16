import { useMemo, useState } from 'react';
import type { ItemDefDTO } from '../../../server/src/shared/types';
import { del, errorMessage, patch, post, uploadImage } from '../lib/api';
import { Art } from '../components/Art';
import { Empty, Field, SearchBox } from '../components/Form';
import { IconEdit, IconPlus, IconTrash, IconUpload, IconX } from '../components/Icons';
import { ConfirmDialog, Modal } from '../components/Modal';
import { useToasts } from '../components/Toasts';
import { PageHead, useGm } from './common';

export function ImagePicker({ imageId, imageUrl, name, onChange, round }: { imageId: string | null; imageUrl: string | null; name: string; onChange: (id: string | null, url: string | null) => void; round?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const r = await uploadImage(file);
      onChange(r.id, r.url);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="image-picker">
      <Art url={imageUrl} name={name || '?'} round={round} className="art-lg" />
      <div className="stack-sm">
        <label className="btn btn-sm file-btn">
          <IconUpload size={16} /> {busy ? 'Uploading…' : imageId ? 'Replace image' : 'Upload image'}
          <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={(e) => onFile(e.target.files?.[0])} disabled={busy} hidden />
        </label>
        {imageId && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => onChange(null, null)}>
            <IconX size={16} /> Remove image
          </button>
        )}
        <span className="muted small">PNG, JPEG, GIF or WebP, up to 2 MB. Without an image a monogram is shown.</span>
        {error && <span className="error-text small">{error}</span>}
      </div>
    </div>
  );
}

function DefDialog({ def, onClose }: { def: ItemDefDTO | null; onClose: () => void }) {
  const [name, setName] = useState(def?.name ?? '');
  const [description, setDescription] = useState(def?.description ?? '');
  const [stackable, setStackable] = useState(def?.stackable ?? true);
  const [image, setImage] = useState<{ id: string | null; url: string | null }>({ id: def?.imageId ?? null, url: def?.imageUrl ?? null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toasts = useToasts();
  const locked = !!def && (def.inUse ?? 0) > 0;
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { name, description, stackable, imageId: image.id };
      if (def) await patch(`/api/gm/item-definitions/${def.id}`, body);
      else await post('/api/gm/item-definitions', body);
      toasts.show(def ? `Saved ${name}.` : `Created ${name}.`, 'success');
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={def ? `Edit ${def.name}` : 'New item definition'}
      onClose={onClose}
      locked={busy}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={busy || !name.trim()}>
            {busy ? 'Saving…' : def ? 'Save' : 'Create'}
          </button>
        </>
      }
    >
      <div className="stack">
        <ImagePicker imageId={image.id} imageUrl={image.url} name={name} onChange={(id, url) => setImage({ id, url })} />
        <Field label="Name">{(id) => <input id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} data-autofocus />}</Field>
        <Field label="Description">{(id) => <textarea id={id} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />}</Field>
        <fieldset className="fieldset">
          <legend>Kind</legend>
          <label className="radio">
            <input type="radio" checked={stackable} onChange={() => setStackable(true)} disabled={locked} />
            <span>
              <strong>Stackable</strong> <span className="muted small">identical units combine (e.g. 5 bricks show as one ×5 stack)</span>
            </span>
          </label>
          <label className="radio">
            <input type="radio" checked={!stackable} onChange={() => setStackable(false)} disabled={locked} />
            <span>
              <strong>Unique</strong> <span className="muted small">each unit is a separate instance with its own ID (e.g. swords, land deeds)</span>
            </span>
          </label>
          {locked && <p className="muted small">The kind cannot change while {def!.inUse} unit(s) exist in inventories.</p>}
        </fieldset>
        {error && <p className="error-box">{error}</p>}
      </div>
    </Modal>
  );
}

export function ItemDefinitions() {
  const { catalog } = useGm();
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<ItemDefDTO | null | 'new'>(null);
  const [deleting, setDeleting] = useState<ItemDefDTO | null>(null);
  const [busy, setBusy] = useState(false);
  const toasts = useToasts();
  const defs = useMemo(() => catalog.itemDefs.filter((d) => !q.trim() || d.name.toLowerCase().includes(q.trim().toLowerCase())), [catalog.itemDefs, q]);

  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      const r = await del<{ removedUnits: number }>(`/api/gm/item-definitions/${deleting.id}`);
      toasts.show(`Deleted ${deleting.name}${r.removedUnits ? ` and removed ${r.removedUnits} unit(s) from inventories` : ''}.`, 'info');
      setDeleting(null);
    } catch (e) {
      toasts.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <PageHead title="Item Definitions" subtitle="Reusable item templates. Add them to inventories from the Inventories page.">
        <button className="btn btn-primary" onClick={() => setEditing('new')}>
          <IconPlus size={18} /> New item
        </button>
      </PageHead>
      <SearchBox value={q} onChange={setQ} placeholder="Search item definitions…" />
      {defs.length === 0 ? (
        <Empty title={q ? 'No items match' : 'No item definitions yet'}>{!q && 'Define items such as bricks, swords or land deeds.'}</Empty>
      ) : (
        <div className="def-grid">
          {defs.map((d) => (
            <article key={d.id} className="def-card">
              <Art url={d.imageUrl} name={d.name} className="def-art" />
              <div className="def-info">
                <h3>{d.name}</h3>
                <span className={`badge ${d.stackable ? 'badge-pending' : 'badge-completed'}`}>{d.stackable ? 'Stackable' : 'Unique'}</span>
                <p className="muted small clamp-2">{d.description || 'No description'}</p>
                <span className="muted small">{d.inUse ?? 0} unit(s) in inventories</span>
              </div>
              <div className="def-actions">
                <button className="btn btn-sm" onClick={() => setEditing(d)}>
                  <IconEdit size={16} /> Edit
                </button>
                <button className="icon-btn danger" onClick={() => setDeleting(d)} aria-label={`Delete ${d.name}`}>
                  <IconTrash size={18} />
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
      {editing && <DefDialog def={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          danger
          busy={busy}
          confirmLabel="Delete definition"
          message={
            (deleting.inUse ?? 0) > 0 ? (
              <>
                This also removes <strong>{deleting.inUse} unit(s)</strong> from every inventory that holds it. The transaction history is kept.
              </>
            ) : (
              'No inventory holds this item. The transaction history is kept.'
            )
          }
          onConfirm={remove}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
