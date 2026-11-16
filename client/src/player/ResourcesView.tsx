import type { CurrencyDTO, InventoryDTO } from '../../../server/src/shared/types';
import { compare } from '../lib/decimal';
import { CurrencyCard } from '../components/CurrencyCard';
import { Empty } from '../components/Form';
import { IconCoins, IconGift } from '../components/Icons';

export function ResourcesView({ inventory, onDonate }: { inventory: InventoryDTO; onDonate: (c: CurrencyDTO) => void }) {
  if (inventory.currencies.length === 0) {
    return (
      <div className="view">
        <Empty title="No resources yet" icon={<IconCoins size={36} />}>
          The GM has not defined any currencies or resources.
        </Empty>
      </div>
    );
  }
  return (
    <div className="view view-scroll">
      <div className="section-head">
        <h2>Resources</h2>
        <p className="muted">Balances are managed by the server. You can donate them to other roles; only the GM can change them directly.</p>
      </div>
      <div className="currency-grid">
        {inventory.currencies.map((c) => {
          const b = inventory.balances.find((x) => x.currencyId === c.id);
          const canGive = !!b && compare(b.available, '0', c.precision) > 0;
          return (
            <CurrencyCard
              key={c.id}
              currency={c}
              balance={b}
              actions={
                <button className="btn btn-primary btn-sm" onClick={() => onDonate(c)} disabled={!canGive}>
                  <IconGift size={16} /> Donate
                </button>
              }
            />
          );
        })}
      </div>
    </div>
  );
}
