/**
 * The review receipt plus the Back / Confirm button pair — the
 * repeated tail of every inline confirm surface on the position page.
 * One component so the busy spinner, the "Waiting for wallet…" state,
 * and the disable logic can't drift between write surfaces.
 */
import type { ReactNode } from 'react';
import { LoaderCircle } from 'lucide-react';
import { copy } from '../content/copy';
import { ReviewReceipt, type ReceiptData } from './ReviewReceipt';

export function ConfirmReceipt({
  data,
  onBack,
  onConfirm,
  busy,
  confirmLabel,
  disabled = false,
  children,
}: {
  data: ReceiptData;
  onBack: () => void;
  onConfirm: () => void;
  busy: boolean;
  confirmLabel: string;
  /** Extra disable conditions beyond `busy` (chain/wallet gates). */
  disabled?: boolean;
  /** Optional banner(s) rendered ABOVE the receipt. */
  children?: ReactNode;
}) {
  return (
    <div>
      {children}
      <ReviewReceipt data={data} />
      <div className="cluster" style={{ marginTop: 12 }}>
        {/* The two controls carry markers so an automated check can tell
            them apart without reading their labels. Identifying the
            fee-paying action by "not the one labelled Back" couples
            control identity to copy: it breaks in any locale, and it
            already misfires in English on a confirm label containing the
            word (#2093 round 76). */}
        <button
          type="button"
          className="btn btn-secondary"
          data-testid="confirm-receipt-back"
          onClick={onBack}
          disabled={busy}
        >
          {copy.common.back}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          data-testid="confirm-receipt-confirm"
          style={{ flex: 1 }}
          disabled={busy || disabled}
          onClick={onConfirm}
        >
          {busy ? <LoaderCircle className="spin" aria-hidden size={18} /> : null}
          {busy ? copy.common.waitingForWallet : confirmLabel}
        </button>
      </div>
    </div>
  );
}
