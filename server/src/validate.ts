import { badRequest } from './errors.js';

export function str(input: unknown, what: string, opts: { min?: number; max?: number; optional?: boolean } = {}): string {
  if (input === undefined || input === null) {
    if (opts.optional) return '';
    throw badRequest(`${what} is required.`);
  }
  if (typeof input !== 'string') throw badRequest(`${what} must be text.`);
  const s = input.trim();
  const min = opts.min ?? (opts.optional ? 0 : 1);
  if (s.length < min) throw badRequest(min <= 1 ? `${what} is required.` : `${what} must be at least ${min} characters.`);
  if (s.length > (opts.max ?? 200)) throw badRequest(`${what} must be at most ${opts.max ?? 200} characters.`);
  return s;
}

/** A single-line display name: whitespace collapsed. */
export function name(input: unknown, what = 'Name', max = 80): string {
  return str(typeof input === 'string' ? input.replace(/\s+/g, ' ') : input, what, { max });
}

export function optText(input: unknown, what: string, max = 2000): string | null {
  if (input === undefined || input === null) return null;
  const s = str(input, what, { optional: true, max });
  return s === '' ? null : s;
}

export function positiveInt(input: unknown, what = 'Quantity', max = 1_000_000_000): number {
  const n = typeof input === 'string' && /^\d+$/.test(input.trim()) ? Number(input) : input;
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) throw badRequest(`${what} must be a whole number greater than zero.`);
  if (n > max) throw badRequest(`${what} is too large.`);
  return n;
}

export function bool(input: unknown, what: string): boolean {
  if (typeof input !== 'boolean') throw badRequest(`${what} must be true or false.`);
  return input;
}

export function id(input: unknown, what: string): string {
  if (typeof input !== 'string' || input.length === 0 || input.length > 100) throw badRequest(`${what} is required.`);
  return input;
}

export function username(input: unknown): string {
  const s = str(input, 'Username', { min: 2, max: 40 });
  if (!/^[A-Za-z0-9_.-]+$/.test(s)) throw badRequest('Username may contain only letters, digits, dot, dash and underscore.');
  return s;
}

export function password(input: unknown): string {
  if (typeof input !== 'string') throw badRequest('Password is required.');
  if (input.length < 6) throw badRequest('Password must be at least 6 characters.');
  if (input.length > 200) throw badRequest('Password is too long.');
  return input;
}
