import type { CurrencyDTO } from '../../../server/src/shared/types';
import { fraction } from '../lib/decimal';
import { prettyAmount } from '../lib/format';

/**
 * Optional visual gauge for a resource. Drawn only when the currency has a configured
 * maximum (the minimum defaults to zero); otherwise there is no "full" or "empty" to show.
 */
export function Gauge({ currency, amount }: { currency: CurrencyDTO; amount: string }) {
  if (currency.gauge === 'none' || currency.max === null) return null;
  const min = currency.min ?? '0';
  const f = fraction(amount, min, currency.max, currency.precision);
  const pct = Math.round(f * 100);
  if (currency.gauge === 'bar') {
    return (
      <div className="gauge-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`${currency.name} ${pct}% of maximum`}>
        <div className="gauge-bar-track">
          <div className="gauge-bar-fill" style={{ width: `${f * 100}%`, background: currency.color }} />
        </div>
        <div className="gauge-bar-scale">
          <span>{prettyAmount(min)}</span>
          <span>{prettyAmount(currency.max)}</span>
        </div>
      </div>
    );
  }
  // Dial: a 240° arc.
  const size = 96;
  const r = 38;
  const cx = size / 2;
  const cy = size / 2 + 4;
  const start = 150;
  const sweep = 240;
  const polar = (deg: number) => {
    const a = (deg * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  };
  const arc = (from: number, to: number) => {
    const [x1, y1] = polar(from);
    const [x2, y2] = polar(to);
    const large = to - from > 180 ? 1 : 0;
    return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
  };
  const end = start + sweep * f;
  const [nx, ny] = polar(end);
  return (
    <div className="gauge-dial" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`${currency.name} ${pct}% of maximum`}>
      <svg width={size} height={size - 14} viewBox={`0 0 ${size} ${size - 14}`}>
        <path d={arc(start, start + sweep)} className="dial-track" strokeWidth={8} fill="none" strokeLinecap="round" />
        {f > 0.001 && <path d={arc(start, end)} stroke={currency.color} strokeWidth={8} fill="none" strokeLinecap="round" />}
        <circle cx={nx} cy={ny} r={5} fill="var(--surface)" stroke={currency.color} strokeWidth={3} />
      </svg>
      <span className="gauge-dial-pct">{pct}%</span>
    </div>
  );
}
