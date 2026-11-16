import { useState } from 'react';
import type { DonationDTO } from '../../../server/src/shared/types';
import { errorMessage, post, serverNow } from '../lib/api';
import { donationSummary, mmss } from '../lib/format';
import { useTicker } from '../lib/live';
import { CountdownDial } from '../components/CountdownDial';
import { useToasts } from '../components/Toasts';

const CANCEL_WINDOW_MS = 5000;

/**
 * Floating tray with the sender's in-flight donations. The dial is only a display: the server
 * enforces the deadline, and a cancel that arrives too late is refused by the server.
 */
export function CountdownTray({ donations, onChanged, onOpenPending }: { donations: DonationDTO[]; onChanged: () => void; onOpenPending: () => void }) {
  const counting = donations.filter((d) => d.status === 'countdown');
  const pending = donations.filter((d) => d.status === 'pending');
  useTicker(100, counting.length > 0);
  useTicker(1000, pending.length > 0 && counting.length === 0);
  const [busy, setBusy] = useState<string | null>(null);
  const toasts = useToasts();
  if (counting.length === 0 && pending.length === 0) return null;
  const now = serverNow();

  const cancel = async (d: DonationDTO) => {
    setBusy(d.id);
    try {
      await post(`/api/donations/${d.id}/cancel`);
      toasts.show('Donation cancelled. Your assets are released.', 'info');
    } catch (e) {
      toasts.show(errorMessage(e), 'error');
    } finally {
      setBusy(null);
      onChanged();
    }
  };

  return (
    <div className="tray" aria-live="polite">
      {counting.map((d) => {
        const remaining = d.cancelDeadline - now;
        const expired = remaining <= 0;
        return (
          <div key={d.id} className="tray-card">
            <CountdownDial remainingMs={remaining} totalMs={CANCEL_WINDOW_MS} />
            <div className="tray-text">
              <strong>{expired ? 'Sending…' : `Donating to ${d.recipientRoleName}`}</strong>
              <span className="muted small">{donationSummary(d, 2)}</span>
            </div>
            <button className="btn btn-danger btn-cancel" onClick={() => cancel(d)} disabled={expired || busy === d.id}>
              Cancel
            </button>
          </div>
        );
      })}
      {pending.length > 0 && (
        <button className="tray-card tray-pending" onClick={onOpenPending}>
          <span className="pending-pip" aria-hidden="true" />
          <span className="tray-text">
            <strong>
              {pending.length} donation{pending.length > 1 ? 's' : ''} awaiting approval
            </strong>
            <span className="muted small">
              {pending[0].recipientRoleName} · {mmss((pending[0].approvalDeadline ?? now) - now)} left
            </span>
          </span>
        </button>
      )}
    </div>
  );
}
