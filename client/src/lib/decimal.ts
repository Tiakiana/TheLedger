/**
 * Tiny exact decimal helpers for the UI (input validation and gauges). The server performs
 * all authoritative arithmetic; these only prevent obviously invalid submissions.
 */
export function toUnits(amount: string, precision: number): bigint | null {
  const m = /^(-)?(\d+)(?:\.(\d*))?$/.exec(amount.trim());
  if (!m) return null;
  const frac = (m[3] ?? '').replace(/0+$/, '');
  if (frac.length > precision) return null;
  const v = BigInt(m[2] + frac.padEnd(precision, '0'));
  return m[1] ? -v : v;
}

export function isValidAmount(amount: string, precision: number): boolean {
  return toUnits(amount, precision) !== null;
}

export function compare(a: string, b: string, precision: number): number {
  const x = toUnits(a, precision) ?? 0n;
  const y = toUnits(b, precision) ?? 0n;
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Position of value within [min, max] as 0..1 (only meaningful when both bounds exist). */
export function fraction(value: string, min: string, max: string, precision: number): number {
  const v = Number(toUnits(value, precision) ?? 0n);
  const lo = Number(toUnits(min, precision) ?? 0n);
  const hi = Number(toUnits(max, precision) ?? 0n);
  if (hi <= lo) return 0;
  return Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
}
