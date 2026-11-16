import { useState } from 'react';
import type { DonationDTO, PlayerStateDTO } from '../../../server/src/shared/types';
import { errorMessage, post, serverNow } from '../lib/api';
import { mmss } from '../lib/format';
import { useTicker } from '../lib/live';
import { CountdownDial } from '../components/CountdownDial';
import { DonationCard } from '../components/DonationCard';
import { Empty } from '../components/Form';
import { IconCheck, IconInbox, IconX } from '../components/Icons';
import { useToasts } from '../components/Toasts';

const APPROVAL_MS = 5 * 60_000;

function ApprovalTimer({ d }: { d: DonationDTO }) {
  const remaining = (d.approvalDeadline ?? 0) - serverNow();
  return (
    <div className="approval-timer">
      <CountdownDial remainingMs={remaining} totalMs={APPROVAL_MS} size={32} label={`${mmss(remaining)} left to decide`} showSeconds={false} />
      <span className="mono">{remaining > 0 ? mmss(remaining) : 'Expired'}</span>
    </div>
  );
}

export function PendingView({ state, onChanged }: { state: PlayerStateDTO; onChanged: () => void }) {
  const incoming = state.incoming;
  const awaiting = state.outgoing.filter((d) => d.status === 'pending');
  useTicker(1000, incoming.length + awaiting.length > 0);
  const [busy, setBusy] = useState<string | null>(null);
  const toasts = useToasts();

  const act = async (d: DonationDTO, action: 'accept' | 'reject') => {
    setBusy(d.id);
    try {
      await post(`/api/donations/${d.id}/${action}`);
      toasts.show(action === 'accept' ? `Accepted the donation from ${d.senderRoleName}.` : `Rejected; the assets were returned to ${d.senderRoleName}.`, action === 'accept' ? 'success' : 'info');
    } catch (e) {
      toasts.show(errorMessage(e), 'error');
    } finally {
      setBusy(null);
      onChanged();
    }
  };

  return (
    <div className="view view-scroll">
      <div className="section-head">
        <h2>Pending donations</h2>
        <p className="muted">
          {state.approvalRequired
            ? 'Incoming donations need approval from someone in your role within 5 minutes. Unanswered donations are returned automatically.'
            : 'Recipient approval is currently switched off by the GM; donations complete automatically after the 5-second cancellation window.'}
        </p>
      </div>
      <section className="stack-sm">
        <h3>Awaiting your decision {incoming.length > 0 && <span className="tab-badge">{incoming.length}</span>}</h3>
        {incoming.length === 0 ? (
          <Empty title="Nothing to decide" icon={<IconInbox size={30} />}>
            New donations to {state.inventory?.role.name} will appear here.
          </Empty>
        ) : (
          incoming.map((d) => (
            <DonationCard key={d.id} donation={d} perspective="recipient" aside={<ApprovalTimer d={d} />}>
              <button className="btn" onClick={() => act(d, 'reject')} disabled={busy === d.id}>
                <IconX size={18} /> Reject
              </button>
              <button className="btn btn-primary" onClick={() => act(d, 'accept')} disabled={busy === d.id}>
                <IconCheck size={18} /> Accept
              </button>
            </DonationCard>
          ))
        )}
      </section>
      {awaiting.length > 0 && (
        <section className="stack-sm">
          <h3>Sent, awaiting the recipient</h3>
          {awaiting.map((d) => (
            <DonationCard key={d.id} donation={d} perspective="sender" aside={<ApprovalTimer d={d} />} />
          ))}
        </section>
      )}
      {state.recent.length > 0 && (
        <section className="stack-sm">
          <h3>Recently resolved</h3>
          {state.recent.map((d) => (
            <DonationCard key={d.id} donation={d} perspective={d.senderRoleId === state.inventory?.role.id ? 'sender' : 'recipient'} />
          ))}
        </section>
      )}
    </div>
  );
}
