/**
 * The live offset's standing surface — rendered on the CHAIN's say-so
 * (the borrower NFT's PrecloseOffset lock), outside every strategy
 * gate, so the banner, funding watch, and cancel affordance survive
 * mode switches, data hiccups, and offsets made on another device.
 *
 * Completion is automatic (the acceptance transaction settles the old
 * loan), so this card's jobs are: explain the wait, keep the
 * completion pull FUNDED (an allowance clobbered by a sibling flow's
 * zero-first approve, or a spent-down balance, makes every acceptance
 * revert — the counterparty pays gas for our shortfall), and offer
 * cancel (which unlocks the position and refunds the offer escrow to
 * the vault).
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { usePublicClient, useWalletClient } from 'wagmi';
import { copy } from '../content/copy';
import { captureTxError } from '../lib/errors';
import { useActiveChain } from '../chain/useActiveChain';
import { useDiamondWrite } from '../contracts/diamond';
import { ensureAllowance, revokeAllowance } from '../contracts/erc20';
import type { OffsetPendingState } from '../data/offsetPending';
import { formatTokenAmount } from '../lib/format';
import type { TokenMeta } from '../contracts/erc20';

export function OffsetPendingCard({
  offerId,
  state,
  principalAsset,
  principalMeta,
  busy,
  setBusy,
  onCleared,
  onDone,
}: {
  /** Device-remembered linked offer id — null when the lock was seen
   *  but this device never learned the id (cancel degrades to a
   *  pointer at the offers list). */
  offerId: string | null;
  state: OffsetPendingState | undefined;
  principalAsset: `0x${string}`;
  principalMeta: TokenMeta | undefined;
  busy: boolean;
  setBusy: (b: boolean) => void;
  onCleared: () => void;
  onDone: (msg: string) => void;
}) {
  const { address, walletChain, onSupportedChain } = useActiveChain();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });
  const { write } = useDiamondWrite();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const walletReady =
    onSupportedChain && Boolean(walletClient) && Boolean(publicClient);
  const boundStr =
    state && principalMeta
      ? `${formatTokenAmount(state.completionBound, principalMeta.decimals)} ${principalMeta.symbol}`
      : null;

  async function cancel() {
    if (!walletReady || offerId === null || !address || !walletChain) return;
    setBusy(true);
    setError(null);
    try {
      await write('cancelOffer', [BigInt(offerId)]);
      // The posting-time approval was sized principal + completion
      // bound; posting consumed only the principal leg, so a payoff-
      // sized authorization outlives the cancel. Unwind it so "fully
      // cancelled" means fully cancelled (Codex #1500 r1) — best
      // effort: a rejected revoke leaves the cancel done and points at
      // the wallet's approvals view as the remedy.
      try {
        await revokeAllowance({
          publicClient: publicClient!,
          walletClient: walletClient!,
          token: principalAsset,
          owner: address,
          spender: walletChain.diamondAddress,
        });
        onDone(copy.offset.cancelled);
      } catch {
        onDone(copy.offset.cancelledApprovalRemains);
      }
      onCleared();
      void queryClient.invalidateQueries({ queryKey: ['offsetPending'] });
      void queryClient.invalidateQueries({ queryKey: ['myOffers'] });
      void queryClient.invalidateQueries({ queryKey: ['activeOffers'] });
    } catch (err) {
      setError(captureTxError(err));
    } finally {
      setBusy(false);
    }
  }

  async function restoreApproval() {
    if (!walletReady || !address || !walletChain || !state) return;
    setBusy(true);
    setError(null);
    try {
      await ensureAllowance({
        publicClient: publicClient!,
        walletClient: walletClient!,
        token: principalAsset,
        owner: address,
        spender: walletChain.diamondAddress,
        amount: state.completionBound,
      });
      onDone(copy.offset.approvalRestored);
      void queryClient.invalidateQueries({ queryKey: ['offsetPending'] });
    } catch (err) {
      setError(captureTxError(err));
    } finally {
      setBusy(false);
    }
  }

  // A dead offset (the loan settled another way, or the GTC offer's
  // replacement term slid past the point where it can still end by the
  // original maturity) can never complete — the card's story flips to
  // cancel-to-unwind and every completion-flavoured line goes away
  // (Codex #1500 r1).
  const completable =
    state === undefined || (state.loanActive && !state.termUnfillable);

  return (
    <section className="card">
      <h3>{copy.offset.pendingTitle}</h3>
      <p className="muted">
        {state !== undefined && !state.loanActive
          ? copy.offset.pendingLoanClosed
          : state?.termUnfillable
            ? copy.offset.pendingTermUnfillable
            : copy.offset.pendingBody}{' '}
        {offerId !== null
          ? copy.offset.pendingOffer(offerId)
          : copy.offset.pendingOfferUnknown}
      </p>
      <div className="banner banner-warn" role="note">
        <span className="banner-body">{copy.offset.lockWarn}</span>
      </div>
      {completable ? (
        <div className="banner banner-warn" role="note" style={{ marginTop: 8 }}>
          <span className="banner-body">{copy.offset.blockedOtherPaths}</span>
        </div>
      ) : null}
      {boundStr && completable ? (
        <p className="muted" style={{ marginTop: 8 }}>
          {copy.offset.pendingKeepFunded(boundStr)}
        </p>
      ) : null}
      {state?.allowanceShort && completable ? (
        <div className="banner banner-danger" role="alert" style={{ marginTop: 8 }}>
          <span className="banner-body">{copy.offset.pendingAllowanceShort}</span>
        </div>
      ) : null}
      {state?.balanceShort && completable ? (
        <div className="banner banner-danger" role="alert" style={{ marginTop: 8 }}>
          <span className="banner-body">{copy.offset.pendingBalanceShort}</span>
        </div>
      ) : null}
      <div className="cluster" style={{ marginTop: 12 }}>
        {state?.allowanceShort && completable ? (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy || !walletReady}
            onClick={() => void restoreApproval()}
          >
            {copy.offset.restoreApproval}
          </button>
        ) : null}
        {offerId !== null ? (
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy || !walletReady || state?.cancelUnlocked === false}
            onClick={() => void cancel()}
          >
            {copy.offset.cancel}
          </button>
        ) : null}
      </div>
      {state?.cancelUnlocked === false && offerId !== null ? (
        <p className="field-hint" style={{ marginTop: 8 }}>
          {copy.offset.cancelCooldown}
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
