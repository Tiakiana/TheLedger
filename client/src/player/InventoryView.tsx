import { useMemo, useState } from 'react';
import type { EntryDTO, PlayerStateDTO } from '../../../server/src/shared/types';
import { post } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { Art } from '../components/Art';
import { ResourceStrip } from '../components/CurrencyCard';
import { Empty } from '../components/Form';
import { IconBox, IconGift, IconLock, IconMove } from '../components/Icons';
import { InventoryGrid, useSortMode } from '../components/InventoryGrid';
import { Modal } from '../components/Modal';
import { useToasts } from '../components/Toasts';

export function InventoryView({ state, userId, onDonate, onShowResources }: { state: PlayerStateDTO; userId: string; onDonate: (e: EntryDTO) => void; onShowResources: () => void }) {
  const inv = state.inventory!;
  const [detailId, setDetailId] = useState<string | null>(null);
  const [moving, setMoving] = useState<EntryDTO | null>(null);
  const toasts = useToasts();
  const sortKey = `ledger.sort.${userId}`;
  const [sort, setSort] = useSortMode(sortKey);
  const detail = useMemo(() => inv.entries.find((e) => e.id === detailId) ?? null, [inv.entries, detailId]);

  const reorder = async (entryId: string, beforeEntryId: string | null) => {
    try {
      await post('/api/me/inventory/reorder', { entryId, beforeEntryId });
    } catch (e) {
      toasts.error(e);
      throw e;
    }
  };

  return (
    <div className="view view-inventory">
      <ResourceStrip currencies={inv.currencies} balances={inv.balances} onClick={onShowResources} />
      <InventoryGrid
        key={sortKey}
        entries={inv.entries}
        sort={sort}
        onSortChange={setSort}
        onOpen={(e) => setDetailId(e.id)}
        onReorder={reorder}
        moving={moving}
        onMovingChange={setMoving}
        emptyState={
          <Empty title="Your inventory is empty" icon={<IconBox size={36} />}>
            Items the GM gives you, or that other roles donate to you, will appear here.
          </Empty>
        }
      />
      {detail && (
        <ItemDetail
          entry={detail}
          canMove={sort === 'custom' && inv.entries.length > 1}
          onClose={() => setDetailId(null)}
          onDonate={() => {
            setDetailId(null);
            onDonate(detail);
          }}
          onMove={() => {
            setDetailId(null);
            setMoving(detail);
          }}
        />
      )}
    </div>
  );
}

export function ItemFacts({ entry }: { entry: EntryDTO }) {
  return (
    <dl className="facts">
      <dt>Type</dt>
      <dd>{entry.kind === 'stack' ? 'Stackable' : 'Unique item'}</dd>
      {entry.kind === 'stack' ? (
        <>
          <dt>Quantity</dt>
          <dd>
            <strong>{entry.quantity}</strong>
            {entry.reserved > 0 && (
              <span className="reserved-note">
                {' '}
                ({entry.reserved} reserved, {entry.available} available)
              </span>
            )}
          </dd>
        </>
      ) : (
        <>
          <dt>Instance</dt>
          <dd>
            <code title={entry.id}>{entry.id.slice(0, 8)}</code>
          </dd>
        </>
      )}
      {entry.customName && (
        <>
          <dt>Item</dt>
          <dd>{entry.defName}</dd>
        </>
      )}
      <dt>Acquired</dt>
      <dd>{formatDateTime(entry.acquiredAt)}</dd>
    </dl>
  );
}

function ItemDetail({ entry, canMove, onClose, onDonate, onMove }: { entry: EntryDTO; canMove: boolean; onClose: () => void; onDonate: () => void; onMove: () => void }) {
  return (
    <Modal
      title={entry.name}
      onClose={onClose}
      footer={
        <>
          {canMove && (
            <button className="btn" onClick={onMove}>
              <IconMove size={18} /> Move
            </button>
          )}
          <span className="spacer" />
          <button className="btn btn-primary" onClick={onDonate} disabled={entry.available === 0}>
            <IconGift size={18} /> Donate
          </button>
        </>
      }
    >
      <div className="detail">
        <div className="detail-art">
          <Art url={entry.imageUrl} name={entry.name} />
          {entry.kind === 'stack' && <span className="qty-badge qty-badge-lg">×{entry.quantity}</span>}
        </div>
        <div className="stack-sm">
          {entry.description ? <p className="detail-desc">{entry.description}</p> : <p className="muted">No description.</p>}
          <ItemFacts entry={entry} />
          {entry.available === 0 && (
            <p className="notice">
              <IconLock size={14} /> This item is reserved by a donation in progress.
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}
