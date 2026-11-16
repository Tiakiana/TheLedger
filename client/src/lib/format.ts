import type { DonationDTO, DonationLineDTO, DonationStatus } from '../../../server/src/shared/types';

export function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function relativeTime(ms: number, now = Date.now()): string {
  const s = Math.round((now - ms) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ms).toLocaleDateString();
}

export function mmss(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Thousands separators for a decimal string, without converting to a float. */
export function prettyAmount(amount: string): string {
  const neg = amount.startsWith('-');
  const [whole, frac] = (neg ? amount.slice(1) : amount).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${neg ? '−' : ''}${grouped}${frac !== undefined ? '.' + frac : ''}`;
}

export function lineText(l: DonationLineDTO): string {
  if (l.assetType === 'currency') return `${prettyAmount(l.quantity)} ${l.name}`;
  return l.quantity === '1' ? l.name : `${l.quantity}× ${l.name}`;
}

export function donationSummary(d: DonationDTO, max = 3): string {
  const parts = d.lines.map(lineText);
  return parts.length <= max ? parts.join(', ') : `${parts.slice(0, max).join(', ')} +${parts.length - max} more`;
}

export const STATUS_LABEL: Record<DonationStatus, string> = {
  countdown: 'Cancellable',
  pending: 'Awaiting approval',
  completed: 'Completed',
  cancelled: 'Cancelled',
  rejected: 'Rejected',
  failed: 'Failed',
};

export function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  return (words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0]).toUpperCase();
}

/** Stable pleasant hue for placeholder art, derived from a string. */
export function hueOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}
