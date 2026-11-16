import type { ReactNode } from 'react';
import type { BalanceDTO, CurrencyDTO } from '../../../server/src/shared/types';
import { compare } from '../lib/decimal';
import { prettyAmount } from '../lib/format';
import { Art } from './Art';
import { Gauge } from './Gauge';
import { IconLock } from './Icons';

export function CurrencyCard({ currency, balance, actions }: { currency: CurrencyDTO; balance: BalanceDTO | undefined; actions?: ReactNode }) {
  const amount = balance?.amount ?? '0';
  const reserved = balance?.reserved ?? '0';
  const hasReserved = compare(reserved, '0', currency.precision) > 0;
  return (
    <article className="currency-card" style={{ ['--accent-c' as string]: currency.color }}>
      <div className="currency-head">
        <Art url={currency.iconUrl} name={currency.name} round className="art-sm" />
        <h3>{currency.name}</h3>
      </div>
      <div className="currency-body">
        <div>
          <div className="currency-amount" aria-label={`${currency.name} balance`}>
            {prettyAmount(amount)}
          </div>
          {currency.max !== null && <div className="muted small">of {prettyAmount(currency.max)} maximum</div>}
          {hasReserved && (
            <div className="small reserved-note">
              <IconLock size={12} /> {prettyAmount(reserved)} reserved in donations
            </div>
          )}
        </div>
        <Gauge currency={currency} amount={amount} />
      </div>
      {actions && <div className="currency-actions">{actions}</div>}
    </article>
  );
}

/** Compact strip of balances shown above the inventory. */
export function ResourceStrip({ currencies, balances, onClick }: { currencies: CurrencyDTO[]; balances: BalanceDTO[]; onClick?: () => void }) {
  if (currencies.length === 0) return null;
  return (
    <div className="resource-strip" role="list" aria-label="Resource balances">
      {currencies.map((c) => {
        const b = balances.find((x) => x.currencyId === c.id);
        return (
          <button key={c.id} role="listitem" className="resource-chip" onClick={onClick} title={`${c.name}: ${b?.amount ?? '0'}`}>
            <Art url={c.iconUrl} name={c.name} round className="art-xs" />
            <span className="resource-chip-name">{c.name}</span>
            <strong>{prettyAmount(b?.amount ?? '0')}</strong>
          </button>
        );
      })}
    </div>
  );
}
