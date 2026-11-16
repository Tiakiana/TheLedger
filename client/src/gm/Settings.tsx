import { useState } from 'react';
import { errorMessage, put } from '../lib/api';
import { Spinner } from '../components/Form';
import { useToasts } from '../components/Toasts';
import { PageHead, useFetch, useGm } from './common';

export function Settings() {
  const { version } = useGm();
  const { data, reload } = useFetch<{ approvalRequired: boolean; lanAddresses: string[] }>('/api/gm/settings', version);
  const [busy, setBusy] = useState(false);
  const toasts = useToasts();
  if (!data) return <Spinner />;

  const toggle = async () => {
    setBusy(true);
    try {
      const r = await put<{ approvalRequired: boolean }>('/api/gm/settings', { approvalRequired: !data.approvalRequired });
      toasts.show(r.approvalRequired ? 'Recipients must now accept donations within 5 minutes.' : 'Donations now complete automatically after the cancellation window.', 'success');
      await reload();
    } catch (e) {
      toasts.show(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack-lg">
      <PageHead title="Settings" subtitle="Server-wide configuration." />
      <section className="panel stack">
        <div className="setting-row">
          <div>
            <h2>Require recipient approval</h2>
            <p className="muted">
              When on, a donation waits up to <strong>5 minutes</strong> after its 5-second cancellation window for a player of the recipient role to accept or reject it. Unanswered donations are rejected
              automatically and the assets return to the sender. When off (the default), donations complete automatically after the cancellation window.
            </p>
            <p className="muted small">The change applies to donations whose cancellation window ends after you switch it. Donations already awaiting approval keep their deadline.</p>
          </div>
          <button className={`switch ${data.approvalRequired ? 'on' : ''}`} role="switch" aria-checked={data.approvalRequired} onClick={toggle} disabled={busy} aria-label="Require recipient approval">
            <span className="switch-knob" />
          </button>
        </div>
      </section>
      <section className="panel stack-sm">
        <h2>Connecting players</h2>
        <p className="muted">Players on the same network can open one of these addresses in their browser:</p>
        <ul className="plain">
          {[location.origin, ...data.lanAddresses.filter((a) => !a.startsWith(location.origin))].map((a) => (
            <li key={a}>
              <code>{a}</code>
            </li>
          ))}
        </ul>
        <p className="muted small">Local and online installations are independent; nothing is synchronised between them.</p>
      </section>
    </div>
  );
}
