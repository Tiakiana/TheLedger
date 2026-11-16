import { badRequest } from './errors.js';

/**
 * Exact decimal arithmetic for currencies.
 *
 * Every currency amount is stored as an integer number of "minor units"
 * (amount × 10^precision). Integer arithmetic on JavaScript numbers is exact as long as
 * values stay within ±Number.MAX_SAFE_INTEGER, which every operation checks.
 * Amounts travel to and from clients as decimal strings, never as floats.
 */

export const MAX_PRECISION = 6;
const LIMIT = Number.MAX_SAFE_INTEGER;

export function assertSafe(units: number, what = 'Amount'): number {
  if (!Number.isSafeInteger(units)) throw badRequest(`${what} is too large.`);
  return units;
}

export function addUnits(a: number, b: number): number {
  return assertSafe(a + b, 'Resulting balance');
}

export function subUnits(a: number, b: number): number {
  return assertSafe(a - b, 'Resulting balance');
}

/** Parses a decimal string such as "12.50" or "-3" into minor units. */
export function parseAmount(input: unknown, precision: number, opts: { allowNegative?: boolean; what?: string } = {}): number {
  const what = opts.what ?? 'Amount';
  let text: string;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw badRequest(`${what} must be a number.`);
    // Accept plain JSON numbers but convert via their shortest decimal representation.
    text = String(input);
    if (/e/i.test(text)) throw badRequest(`${what} must be written as a plain decimal number.`);
  } else if (typeof input === 'string') {
    text = input.trim();
  } else {
    throw badRequest(`${what} is required.`);
  }
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) throw badRequest(`${what} must be a decimal number like 12 or 12.5.`);
  const [, neg, whole, frac = ''] = m;
  if (neg && !opts.allowNegative) throw badRequest(`${what} cannot be negative.`);
  const trimmedFrac = frac.replace(/0+$/, '');
  if (trimmedFrac.length > precision) {
    throw badRequest(precision === 0 ? `${what} must be a whole number.` : `${what} allows at most ${precision} decimal place${precision === 1 ? '' : 's'}.`);
  }
  const digits = (whole.replace(/^0+(?=\d)/, '') + trimmedFrac.padEnd(precision, '0')).replace(/^0+(?=\d)/, '');
  if (digits.length > 16) throw badRequest(`${what} is too large.`);
  const big = BigInt(digits);
  if (big > BigInt(LIMIT)) throw badRequest(`${what} is too large.`);
  const units = Number(big);
  return neg && units !== 0 ? -units : units;
}

/** Formats minor units as a decimal string with exactly `precision` decimals. */
export function formatAmount(units: number, precision: number): string {
  const neg = units < 0;
  const abs = BigInt(Math.abs(units)).toString();
  if (precision === 0) return (neg ? '-' : '') + abs;
  const padded = abs.padStart(precision + 1, '0');
  const whole = padded.slice(0, padded.length - precision);
  const frac = padded.slice(padded.length - precision);
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

/** Rescales stored units when a currency's precision changes. Returns null if it would lose information. */
export function rescaleUnits(units: number, from: number, to: number): number | null {
  if (to === from) return units;
  if (to > from) {
    const factor = 10 ** (to - from);
    const r = units * factor;
    return Number.isSafeInteger(r) ? r : null;
  }
  const factor = 10 ** (from - to);
  if (units % factor !== 0) return null;
  return units / factor;
}
