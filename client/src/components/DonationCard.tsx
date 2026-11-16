import type { ReactNode } from 'react';
import type { DonationDTO } from '../../../server/src/shared/types';
import { formatDateTime, lineText, STATUS_LABEL } from '../lib/format';
import { Art } from './Art';
import { StatusBadge } from './Form';
import { IconArrowRight } from './Icons';

export function DonationLines({ donation }: { donation: DonationDTO }) {
  return (
    <ul className="line-list">
      {donation.lines.map((l) => (
        <li key={l.id}>
          <Art url={l.imageUrl} name={l.name} round={l.assetType === 'currency'} className="art-xs" />
          <span>{lineText(l)}</span>
        </li>
      ))}
    </ul>
  );
}

export function DonationCard({ donation, perspective, children, aside }: { donation: DonationDTO; perspective?: 'sender' | 'recipient' | 'gm'; children?: ReactNode; aside?: ReactNode }) {
  const d = donation;
  return (
    <article className={`donation-card status-${d.status}`}>
      <header className="donation-head">
        <div className="donation-route">
          <strong>{perspective === 'sender' ? 'You' : d.senderRoleName}</strong>
          <IconArrowRight size={16} />
          <strong>{perspective === 'recipient' ? 'You' : d.recipientRoleName}</strong>
        </div>
        <StatusBadge status={d.status} label={STATUS_LABEL[d.status]} />
      </header>
      <div className="donation-body">
        <DonationLines donation={d} />
        {aside}
      </div>
      <footer className="donation-meta muted small">
        <code>{d.id}</code> · by {d.createdByUsername} · {formatDateTime(d.createdAt)}
        {d.resolutionNote && d.status !== 'countdown' && d.status !== 'pending' && <> · {d.resolutionNote}</>}
        {d.resolvedByUsername && <> ({d.resolvedByUsername})</>}
      </footer>
      {children && <div className="donation-actions">{children}</div>}
    </article>
  );
}
