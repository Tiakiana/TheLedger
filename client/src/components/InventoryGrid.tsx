import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import type { EntryDTO } from '../../../server/src/shared/types';
import { Art } from './Art';
import { SearchBox, Empty } from './Form';
import { IconBox, IconHand, IconLock, IconMove, IconSort } from './Icons';

export type SortMode = 'custom' | 'name-asc' | 'name-desc' | 'qty-desc' | 'qty-asc' | 'recent' | 'oldest';

export const SORT_LABELS: Record<SortMode, string> = {
  custom: 'Custom order',
  'name-asc': 'Name A → Z',
  'name-desc': 'Name Z → A',
  'qty-desc': 'Quantity: most first',
  'qty-asc': 'Quantity: fewest first',
  recent: 'Most recently acquired',
  oldest: 'Least recently acquired',
};

const LABEL_H = 48;
const GAP = 12;
const OVERSCAN_ROWS = 3;
export const ENTRY_MIME = 'application/x-ledger-entry';

function sortEntries(list: EntryDTO[], mode: SortMode): EntryDTO[] {
  if (mode === 'custom') return list;
  const byName = (a: EntryDTO, b: EntryDTO) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
  const copy = [...list];
  switch (mode) {
    case 'name-asc':
      return copy.sort(byName);
    case 'name-desc':
      return copy.sort((a, b) => byName(b, a));
    case 'qty-desc':
      return copy.sort((a, b) => b.quantity - a.quantity || byName(a, b));
    case 'qty-asc':
      return copy.sort((a, b) => a.quantity - b.quantity || byName(a, b));
    case 'recent':
      return copy.sort((a, b) => b.acquiredAt - a.acquiredAt || byName(a, b));
    case 'oldest':
      return copy.sort((a, b) => a.acquiredAt - b.acquiredAt || byName(a, b));
  }
}

/** Sort mode is a per-device display preference; it never touches the saved custom order. */
export function useSortMode(storageKey: string): [SortMode, (m: SortMode) => void] {
  const [mode, setMode] = useState<SortMode>(() => {
    try {
      const v = localStorage.getItem(storageKey) as SortMode | null;
      return v && v in SORT_LABELS ? v : 'custom';
    } catch {
      return 'custom';
    }
  });
  return [
    mode,
    (m) => {
      setMode(m);
      try {
        localStorage.setItem(storageKey, m);
      } catch {
        /* storage unavailable */
      }
    },
  ];
}

interface Props {
  entries: EntryDTO[];
  sort: SortMode;
  onSortChange: (m: SortMode) => void;
  onOpen: (e: EntryDTO) => void;
  /** Persist a custom-order move: place entryId before beforeId (null = end). */
  onReorder: (entryId: string, beforeId: string | null) => Promise<void>;
  /** Entry currently being moved with the tap-based method. */
  moving: EntryDTO | null;
  onMovingChange: (e: EntryDTO | null) => void;
  toolbarExtra?: ReactNode;
  emptyState?: ReactNode;
}

export function InventoryGrid({ entries, sort, onSortChange: setSort, onOpen, onReorder, moving, onMovingChange, toolbarExtra, emptyState }: Props) {
  const [query, setQuery] = useState('');
  const [optimistic, setOptimistic] = useState<string[] | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; side: 'before' | 'after' } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const finePointer = useMemo(() => typeof matchMedia !== 'undefined' && matchMedia('(pointer: fine)').matches, []);

  // Server state replaced: drop any optimistic ordering.
  useEffect(() => setOptimistic(null), [entries]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const customOrdered = useMemo(() => {
    if (!optimistic) return entries;
    const byId = new Map(entries.map((e) => [e.id, e]));
    const ordered = optimistic.map((id) => byId.get(id)).filter((e): e is EntryDTO => !!e);
    for (const e of entries) if (!optimistic.includes(e.id)) ordered.push(e);
    return ordered;
  }, [entries, optimistic]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q ? customOrdered.filter((e) => e.name.toLowerCase().includes(q) || e.defName.toLowerCase().includes(q) || e.description.toLowerCase().includes(q)) : customOrdered;
    return sortEntries(filtered, sort);
  }, [customOrdered, query, sort]);

  const canArrange = sort === 'custom' && query.trim() === '';
  const dragEnabled = canArrange && finePointer && !moving;

  // Layout: about five columns on a typical desktop, fewer on narrow screens.
  const width = size.w;
  const desktop = width >= 1000;
  const minTile = width < 420 ? 92 : width < 720 ? 116 : desktop ? 200 : 148;
  const cols = Math.max(2, Math.min(10, Math.floor((width + GAP) / (minTile + GAP)) || 2));
  const tileW = width > 0 ? (width - GAP * (cols - 1)) / cols : minTile;
  // Square art on phones/tablets; on desktop, flatter tiles so roughly five rows fit the viewport.
  const artH = Math.round(desktop ? Math.min(tileW - 14, Math.max(96, (size.h || 600) / 5 - LABEL_H - GAP - 14)) : Math.max(40, tileW - 14));
  const tileH = artH + 14 + LABEL_H;
  const rowH = tileH + GAP;
  const rows = Math.ceil(visible.length / cols);
  const first = Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN_ROWS);
  const last = Math.min(rows - 1, Math.ceil((scrollTop + (size.h || 800)) / rowH) + OVERSCAN_ROWS);

  const reorder = async (entryId: string, beforeId: string | null) => {
    if (entryId === beforeId) return;
    const ids = customOrdered.map((e) => e.id).filter((id) => id !== entryId);
    const at = beforeId === null ? ids.length : ids.indexOf(beforeId);
    ids.splice(at < 0 ? ids.length : at, 0, entryId);
    setOptimistic(ids);
    try {
      await onReorder(entryId, beforeId);
    } catch {
      setOptimistic(null);
    }
  };

  const beforeIdFor = (targetId: string, side: 'before' | 'after', draggedId: string): string | null => {
    if (side === 'before') return targetId;
    const ids = customOrdered.map((e) => e.id).filter((id) => id !== draggedId);
    const i = ids.indexOf(targetId);
    return ids[i + 1] ?? null;
  };

  const onTileDragStart = (e: DragEvent, entry: EntryDTO) => {
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData(ENTRY_MIME, entry.id);
    e.dataTransfer.setData('text/plain', entry.name);
    if (dragEnabled) setDragId(entry.id);
  };

  const onTileDragOver = (e: DragEvent, entry: EntryDTO) => {
    if (!dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const side = e.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
    if (dropTarget?.id !== entry.id || dropTarget.side !== side) setDropTarget({ id: entry.id, side });
  };

  const onTileDrop = (e: DragEvent, entry: EntryDTO) => {
    if (!dragId) return;
    e.preventDefault();
    const side = dropTarget?.id === entry.id ? dropTarget.side : 'before';
    const dragged = dragId;
    setDragId(null);
    setDropTarget(null);
    if (dragged !== entry.id) void reorder(dragged, beforeIdFor(entry.id, side, dragged));
  };

  const onTileClick = (entry: EntryDTO) => {
    if (moving) {
      if (moving.id !== entry.id) void reorder(moving.id, entry.id);
      onMovingChange(null);
      return;
    }
    onOpen(entry);
  };

  const rowsOut: ReactNode[] = [];
  for (let r = first; r <= last; r++) {
    const slice = visible.slice(r * cols, r * cols + cols);
    rowsOut.push(
      <div key={r} className="grid-row" role="row" style={{ transform: `translateY(${r * rowH}px)`, gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: GAP }}>
        {slice.map((entry) => (
          <Tile
            key={entry.id}
            entry={entry}
            artH={artH}
            tileH={tileH}
            draggable={dragEnabled}
            dragging={dragId === entry.id}
            dropSide={dropTarget?.id === entry.id ? dropTarget.side : null}
            moveTarget={!!moving && moving.id !== entry.id}
            movingSelf={moving?.id === entry.id}
            onClick={() => onTileClick(entry)}
            onDragStart={(e) => onTileDragStart(e, entry)}
            onDragOver={(e) => onTileDragOver(e, entry)}
            onDragLeave={() => dropTarget?.id === entry.id && setDropTarget(null)}
            onDrop={(e) => onTileDrop(e, entry)}
            onDragEnd={() => {
              setDragId(null);
              setDropTarget(null);
            }}
          />
        ))}
      </div>,
    );
  }

  return (
    <div className="inv">
      <div className="inv-toolbar">
        <SearchBox value={query} onChange={setQuery} placeholder="Search items…" />
        <label className="sort-select">
          <IconSort size={18} />
          <span className="sr-only">Sort items</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as SortMode)} aria-label="Sort items">
            {(Object.keys(SORT_LABELS) as SortMode[]).map((m) => (
              <option key={m} value={m}>
                {SORT_LABELS[m]}
              </option>
            ))}
          </select>
        </label>
        {toolbarExtra}
      </div>
      <div className="inv-status" aria-live="polite">
        {moving ? (
          <div className="move-banner">
            <IconMove size={18} />
            <span>
              Moving <strong>{moving.name}</strong>: tap the item it should go before.
            </span>
            <span className="spacer" />
            <button
              className="btn btn-sm"
              onClick={() => {
                void reorder(moving.id, null);
                onMovingChange(null);
              }}
            >
              Move to end
            </button>
            <button className="btn btn-sm btn-ghost" onClick={() => onMovingChange(null)}>
              Cancel
            </button>
          </div>
        ) : (
          <>
            <span className={`sort-pill ${sort === 'custom' ? 'sort-pill-custom' : ''}`}>
              <IconSort size={14} /> {SORT_LABELS[sort]}
            </span>
            <span className="muted small">
              {visible.length} {visible.length === 1 ? 'entry' : 'entries'}
              {query && ` matching “${query}”`}
              {' · '}
              {canArrange ? (finePointer ? 'drag to rearrange, or open an item and choose Move' : 'open an item and choose Move to rearrange') : sort !== 'custom' ? 'switch to Custom order to rearrange' : 'clear the search to rearrange'}
            </span>
          </>
        )}
      </div>
      <div className="inv-scroll" ref={scrollRef} onScroll={(e) => setScrollTop((e.target as HTMLElement).scrollTop)}>
        {visible.length === 0 ? (
          query ? (
            <Empty title="No matching items" icon={<IconBox size={32} />}>
              Nothing matches “{query}”.
            </Empty>
          ) : (
            (emptyState ?? <Empty title="This inventory is empty" icon={<IconBox size={32} />} />)
          )
        ) : (
          <div className="grid-canvas" role="grid" aria-rowcount={rows} style={{ height: Math.max(0, rows * rowH - GAP) }}>
            {rowsOut}
          </div>
        )}
      </div>
    </div>
  );
}

interface TileProps {
  entry: EntryDTO;
  artH: number;
  tileH: number;
  draggable: boolean;
  dragging: boolean;
  dropSide: 'before' | 'after' | null;
  moveTarget: boolean;
  movingSelf: boolean;
  onClick: () => void;
  onDragStart: (e: DragEvent) => void;
  onDragOver: (e: DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: DragEvent) => void;
  onDragEnd: () => void;
}

function Tile({ entry, artH, tileH, draggable, dragging, dropSide, moveTarget, movingSelf, onClick, ...dnd }: TileProps) {
  const cls = ['tile', dragging && 'tile-dragging', dropSide && `drop-${dropSide}`, moveTarget && 'tile-move-target', movingSelf && 'tile-moving', entry.available === 0 && 'tile-reserved']
    .filter(Boolean)
    .join(' ');
  return (
    <button type="button" role="gridcell" className={cls} style={{ height: tileH }} draggable={draggable} onClick={onClick} title={entry.name} {...dnd} aria-label={`${entry.name}${entry.kind === 'stack' ? `, quantity ${entry.quantity}` : ', unique'}${entry.reserved ? `, ${entry.reserved} reserved` : ''}`}>
      <div className="tile-art" style={{ height: artH }}>
        <Art url={entry.imageUrl} name={entry.name} />
        {entry.kind === 'stack' && <span className="qty-badge">×{entry.quantity}</span>}
        {entry.kind === 'unique' && (
          <span className="unique-badge" title="Unique item">
            ◆
          </span>
        )}
        {entry.reserved > 0 && (
          <span className="reserved-badge" title={`${entry.reserved} reserved by a pending donation`}>
            <IconLock size={12} /> {entry.kind === 'stack' ? entry.reserved : ''}
          </span>
        )}
        {moveTarget && (
          <span className="move-hint">
            <IconHand size={18} />
          </span>
        )}
      </div>
      <div className="tile-name">{entry.name}</div>
    </button>
  );
}
