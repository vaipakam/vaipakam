/**
 * The live sale listing's standing surface — rendered by the page on
 * the CHAIN's say-so (positionLock == EarlyWithdrawalSale), outside
 * the strategy-card gates, so it survives data hiccups, mode
 * switches, and being listed from another device. Cancel needs the
 * offer id (device-local marker, live-verified); without it the card
 * still shows the lock.
 *
 * There is nothing to fund and nothing to restore (#2674): a buyer's
 * acceptance escrows the buyer's payment and the settlement is deducted
 * from it before the rest reaches the seller (net settlement, #1659).
 *
 * Shares the PAGE's busy lock, so a cancel cannot overlap another
 * write the page is sending for this loan.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useWalletClient } from 'wagmi';
import { copy } from '../content/copy';
import { captureTxError } from '../lib/errors';
import { useActiveChain } from '../chain/useActiveChain';
import { useDiamondWrite } from '../contracts/diamond';
import {
  saleListingCardView,
  type LoanSalePendingState,
} from '../data/loanSalePending';
import { formatDateTime } from '../lib/format';

export function LoanSalePendingCard({
  state,
  stale,
  busy,
  setBusy,
  onCleared,
  onDone,
}: {
  state: LoanSalePendingState;
  /** The latest poll failed, so `state` is the last answer, not a current
   *  one. The card then states nothing drawn from the listing's record. */
  stale: boolean;
  busy: boolean;
  setBusy: (b: boolean) => void;
  onCleared: () => void;
  /** Page-level outcome sink — the card unmounts after cancel, so
   *  its result must outlive it. */
  onDone: (message: string) => void;
}) {
  const { onSupportedChain } = useActiveChain();
  const { data: walletClient } = useWalletClient();
  const { write } = useDiamondWrite();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const walletReady = onSupportedChain && Boolean(walletClient);
  const view = saleListingCardView(state, stale);
  // The cancel control's own gate, so the copy never names a control that
  // is not on the card (Codex #2673 r1).
  const canCancel = Boolean(state.offerId) && state.isHolder;

  async function cancelListing() {
    if (!state.offerId || !walletReady) return;
    setBusy(true);
    setError(null);
    try {
      await write('cancelOffer', [BigInt(state.offerId)]);
      onDone(copy.loanSale.cancelled);
      onCleared();
      void queryClient.invalidateQueries({ queryKey: ['loanSalePending'] });
      void queryClient.invalidateQueries({ queryKey: ['myOffers'] });
    } catch (err) {
      setError(captureTxError(err));
    } finally {
      setBusy(false);
    }
  }

  const listingLine = state.offerId
    ? copy.loanSale.pending(state.offerId)
    : copy.loanSale.pendingNoId;

  return (
    <section className="card">
      <h3>{copy.loanSale.title}</h3>
      <div className="banner banner-warn" role="status">
        <span className="banner-body">
          {/* #1848 — what the listing's own record says, when it was read
              and is current, REPLACES the pre-acceptance text rather than
              sitting under it. */}
          {view === 'settled'
            ? copy.loanSale.loanSettledWhileListed
            : view === 'accepted'
              ? copy.loanSale.acceptedCompleting
              : view === 'expired'
                ? (canCancel
                    ? copy.loanSale.expiredUnsold
                    : copy.loanSale.expiredUnsoldNoCancel)(
                    formatDateTime(Number(state.expiresAt)),
                  )
                : listingLine}
        </span>
      </div>
      {view === 'stale' ? (
        <p className="field-hint" style={{ marginTop: 8 }}>
          {copy.loanSale.staleRecord}
        </p>
      ) : null}
      {view === 'open' || view === 'unread' ? (
        // Open, or unread (listed from another device): the note applies
        // either way; the end time is stated only when it was read.
        <>
          {view === 'open' && state.expiresAt !== null && state.expiresAt !== 0n ? (
            <p className="field-hint" style={{ marginTop: 8 }}>
              {copy.loanSale.openUntil(formatDateTime(Number(state.expiresAt)))}
            </p>
          ) : null}
          {/* #1810 — why a live listing can stop filling, and what the app
              cannot see about it yet. */}
          <p className="field-hint" style={{ marginTop: 8 }}>
            {copy.loanSale.boundsNote}
          </p>
        </>
      ) : null}
      {canCancel ? (
        <div className="cluster" style={{ marginTop: 12 }}>
          <button
            type="button"
            className="btn btn-secondary"
            // Chain-time cancel cooldown — a click before it elapses
            // reverts CancelCooldownActive on-chain.
            disabled={busy || !walletReady || !state.cancelUnlocked}
            onClick={() => void cancelListing()}
          >
            {copy.loanSale.cancel}
          </button>
        </div>
      ) : null}
      {canCancel && !state.cancelUnlocked ? (
        <p className="field-hint" style={{ marginTop: 8 }}>
          {copy.loanSale.cancelSoon}
        </p>
      ) : null}
      {error ? (
        <div className="banner banner-danger" role="alert" style={{ marginTop: 12 }}>
          <span className="banner-body">{error}</span>
        </div>
      ) : null}
    </section>
  );
}
