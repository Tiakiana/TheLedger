import { useRef, useState } from 'react';
import type { DonationLineInput, PlayerStateDTO, RoleRef } from '../../../server/src/shared/types';
import { errorMessage, newRequestId, post } from '../lib/api';
import { compare, isValidAmount } from '../lib/decimal';
import { prettyAmount } from '../lib/format';
import { Art } from '../components/Art';
import { AmountInput, Field, QuantityInput, RolePicker } from '../components/Form';
import { IconArrowLeft, IconGift } from '../components/Icons';
import { Modal } from '../components/Modal';
import { useToasts } from '../components/Toasts';

export type QuickTarget = { kind: 'item'; entryId: string } | { kind: 'currency'; currencyId: string };

export function ApprovalNote({ approvalRequired, recipient }: { approvalRequired: boolean; recipient: string }) {
  return (
    <p className="muted small">
      After you confirm, you have <strong>5 seconds</strong> to cancel.{' '}
      {approvalRequired ? (
        <>
          Then {recipient} has <strong>5 minutes</strong> to accept; if they reject or don't respond, everything returns to you.
        </>
      ) : (
        <>Then the transfer completes automatically.</>
      )}
    </p>
  );
}

/** Workflow A: start from one item or resource, pick a recipient and an amount. */
export function QuickDonate({ target, state, roles, onClose, onSent }: { target: QuickTarget; state: PlayerStateDTO; roles: RoleRef[]; onClose: () => void; onSent: () => void }) {
  const inv = state.inventory!;
  const entry = target.kind === 'item' ? inv.entries.find((e) => e.id === target.entryId) : undefined;
  const currency = target.kind === 'currency' ? inv.currencies.find((c) => c.id === target.currencyId) : undefined;
  const balance = currency ? inv.balances.find((b) => b.currencyId === currency.id) : undefined;
  const [recipientId, setRecipientId] = useState<string | null>(null);
  const [qty, setQty] = useState(1);
  const [amount, setAmount] = useState('');
  const [step, setStep] = useState<'compose' | 'confirm'>('compose');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(newRequestId());
  const toasts = useToasts();

  const recipient = roles.find((r) => r.id === recipientId) ?? null;
  const gone = (target.kind === 'item' && !entry) || (target.kind === 'currency' && !currency);
  const available = entry ? entry.available : 0;
  const amountOk = currency ? isValidAmount(amount, currency.precision) && compare(amount, '0', currency.precision) > 0 && compare(amount, balance?.available ?? '0', currency.precision) <= 0 : true;
  const qtyOk = entry ? qty >= 1 && qty <= available : true;
  const canReview = !gone && !!recipient && qtyOk && amountOk && !busy;

  const lines = (): DonationLineInput[] => (entry ? [{ type: 'item', entryId: entry.id, quantity: entry.kind === 'unique' ? 1 : qty }] : [{ type: 'currency', currencyId: currency!.id, amount: amount.trim() }]);
  const name = entry?.name ?? currency?.name ?? '';
  const what = entry ? (entry.kind === 'unique' ? entry.name : `${qty}× ${entry.name}`) : `${prettyAmount(amount || '0')} ${currency?.name}`;

  const review = async () => {
    setBusy(true);
    setError(null);
    try {
      await post('/api/donations/validate', { recipientRoleId: recipientId, lines: lines() });
      setStep('confirm');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await post('/api/donations', { requestId: requestId.current, recipientRoleId: recipientId, lines: lines() });
      toasts.show(`Donating ${what} to ${recipient!.name}. You can cancel for 5 seconds.`, 'info');
      onSent();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      requestId.current = newRequestId();
      setStep('compose');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={step === 'compose' ? `Donate ${name}` : 'Confirm donation'}
      onClose={onClose}
      locked={busy}
      footer={
        step === 'compose' ? (
          <>
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={review} disabled={!canReview}>
              {busy ? 'Checking…' : 'Review'}
            </button>
          </>
        ) : (
          <>
            <button className="btn" onClick={() => setStep('compose')} disabled={busy}>
              <IconArrowLeft size={18} /> Back
            </button>
            <button className="btn btn-donate" onClick={confirm} disabled={busy}>
              <IconGift size={18} /> {busy ? 'Reserving…' : 'Confirm donation'}
            </button>
          </>
        )
      }
    >
      {gone ? (
        <p className="notice">This asset is no longer available in your inventory.</p>
      ) : step === 'compose' ? (
        <div className="stack">
          <div className="asset-head">
            <Art url={entry?.imageUrl ?? currency?.iconUrl ?? null} name={name} round={!!currency} className="art-md" />
            <div>
              <strong>{name}</strong>
              <div className="muted small">{entry ? (entry.kind === 'unique' ? 'Unique item' : `${available} available`) : `${prettyAmount(balance?.available ?? '0')} available`}</div>
            </div>
          </div>
          <Field label="Recipient role">{() => <RolePicker roles={roles} value={recipientId} onChange={setRecipientId} autoFocus />}</Field>
          {entry && entry.kind === 'stack' && <Field label="Quantity">{() => <QuantityInput value={qty} onChange={setQty} max={Math.max(1, available)} />}</Field>}
          {currency && (
            <Field label={`Amount of ${currency.name}`} hint={currency.precision > 0 ? `Up to ${currency.precision} decimal places.` : 'Whole numbers only.'}>
              {() => <AmountInput value={amount} onChange={setAmount} precision={currency.precision} max={balance?.available} invalid={amount !== '' && !amountOk} />}
            </Field>
          )}
          {error && <p className="error-box">{error}</p>}
        </div>
      ) : (
        <div className="stack confirm-box">
          <div className="confirm-summary">
            <Art url={entry?.imageUrl ?? currency?.iconUrl ?? null} name={name} round={!!currency} className="art-lg" />
            <p>
              Give <strong>{what}</strong> to <strong>{recipient?.name}</strong>?
            </p>
          </div>
          <ApprovalNote approvalRequired={state.approvalRequired} recipient={recipient?.name ?? 'the recipient'} />
          {error && <p className="error-box">{error}</p>}
        </div>
      )}
    </Modal>
  );
}
