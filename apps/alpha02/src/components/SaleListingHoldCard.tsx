/**
 * Borrower-side notice for a lender-sale listing on THEIR loan
 * (#1503 PR-A follow-up). Three states, all chain-derived (see
 * data/saleListingHold.ts — the state IS the teardown probe,
 * lock-corroborated):
 *
 *  - `live`: a bounded listing stands. Explains exactly which options
 *    are held (the offset exit + collateral withdrawal), which stay
 *    open (full/partial repay and the direct close), and the
 *    structural bound on how long the hold can last. No action.
 *
 *  - `accepted`: a buyer accepted and completion is pending — the
 *    hold continues, and there is nothing for the borrower to send
 *    (completion is the buyer/lender side's transaction). Notice
 *    only.
 *
 *  - `clearable`: the listing has ended but the hold persists until
 *    the one-time permissionless cleanup runs. The action opens the
 *    app-standard six-row review receipt through the PAGE's single
 *    confirmation slot (Codex #1511 r3 — two receipts must never
 *    invite conflicting signatures) and confirming sends
 *    `teardownStaleSaleListing(loanId)` — deliberately available
 *    even while the protocol is paused (moves no value).
 *
 * The success confirmation is DURABLE: `onCleared` lifts the flag to
 * the page, which keeps this card mounted after the probe refetches
 * to `none`; a NEW listing ('live') outranks and resets the latch.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Hourglass } from 'lucide-react';
import { copy } from '../content/copy';
import { captureTxError } from '../lib/errors';
import { useDiamondWrite } from '../contracts/diamond';
import { ConfirmReceipt } from './ConfirmReceipt';
import type { SaleListingHoldState } from '../data/saleListingHold';

export function SaleListingHoldCard({
  loanId,
  state,
  cleared,
  confirmOpen,
  onOpenConfirm,
  onCloseConfirm,
  busy,
  setBusy,
  onCleared,
}: {
  /** PAGE-owned durable success flag (with its drained-lifecycle
   *  reset — Codex #1511 r6): the card renders the confirmation from
   *  it and never keeps a competing local latch. */
  cleared: boolean;
  loanId: number;
  state: SaleListingHoldState;
  /** The page's single confirmation slot — opening this receipt
   *  closes any other, and vice versa (Codex #1511 r3). */
  confirmOpen: boolean;
  onOpenConfirm: () => void;
  onCloseConfirm: () => void;
  /** The page-wide write mutex — shared with every other position
   *  write so two wallet prompts can't race. */
  busy: boolean;
  setBusy: (b: boolean) => void;
  /** Lifts the durable success flag to the page — the page keeps the
   *  card mounted on it after the probe refetches to `none`. */
  onCleared: () => void;
}) {
  const { write, ready } = useDiamondWrite();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  if (
    state !== 'live' &&
    state !== 'clearable' &&
    state !== 'accepted' &&
    !cleared
  ) {
    return null;
  }

  async function freeOptions() {
    setError(null);
    setBusy(true);
    try {
      await write('teardownStaleSaleListing', [BigInt(loanId)]);
      onCleared();
      onCloseConfirm();
      void queryClient.invalidateQueries({
        queryKey: ['saleListingHold'],
      });
    } catch (err) {
      setError(captureTxError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" data-testid="sale-listing-hold-card">
      <div className="card-title">
        <Hourglass aria-hidden />
        <h3 style={{ margin: 0 }}>{copy.saleHold.title}</h3>
      </div>
      {cleared && state !== 'live' ? (
        <p className="muted">{copy.saleHold.clearedNote}</p>
      ) : state === 'live' ? (
        <>
          <p className="muted">{copy.saleHold.liveBody}</p>
          <p className="field-hint">{copy.saleHold.liveEnds}</p>
        </>
      ) : state === 'accepted' ? (
        <p className="muted">{copy.saleHold.acceptedBody}</p>
      ) : (
        <>
          <p className="muted">{copy.saleHold.clearableBody}</p>
          {error ? (
            <div
              className="banner banner-danger"
              role="alert"
              style={{ marginBottom: 12 }}
            >
              {error}
            </div>
          ) : null}
          {!confirmOpen ? (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={onOpenConfirm}
              disabled={busy || !ready}
              data-testid="free-held-options"
            >
              {copy.saleHold.clearableAction}
            </button>
          ) : (
            <div style={{ marginTop: 8 }}>
              <ConfirmReceipt
                busy={busy}
                confirmLabel={copy.saleHold.confirmAction}
                onBack={onCloseConfirm}
                onConfirm={() => void freeOptions()}
                disabled={!ready}
                data={{
                  youReceive: copy.saleHold.receipt.youReceive,
                  youLock: copy.saleHold.receipt.youLock,
                  youMayOwe: copy.saleHold.receipt.youMayOwe,
                  youCanLose: copy.saleHold.receipt.youCanLose,
                  fees: copy.saleHold.receipt.fees,
                  whenThisEnds: copy.saleHold.receipt.whenThisEnds,
                }}
              />
            </div>
          )}
        </>
      )}
    </section>
  );
}
