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
import { DIAMOND_ABI_VIEM, useDiamondWrite } from '../contracts/diamond';
import {
  LOAN_STATUS_ACTIVE,
  offsetCompletionBoundOf,
  readLoanLive,
} from '../contracts/loanLive';
import { LOCK_PRECLOSE_OFFSET } from '../data/offsetPending';
import { ensureAllowance } from '../contracts/erc20';
import type { OffsetPendingState } from '../data/offsetPending';
import { formatTokenAmount } from '../lib/format';
import type { TokenMeta } from '../contracts/erc20';

export function OffsetPendingCard({
  loanId,
  borrowerTokenId,
  offerId,
  state,
  principalAsset,
  principalMeta,
  busy,
  setBusy,
  onCleared,
  onDone,
}: {
  loanId: number;
  /** The borrower position token — re-read live before any approval. */
  borrowerTokenId: string;
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
      // NO automatic approval revoke (Codex #1500 r3). The
      // owner→Diamond allowance is ONE shared number per token, and
      // its SIZE cannot identify which commitments rely on it: a
      // sibling refinance request, another loan's offset, or a sale
      // listing may each be resting on an allowance at or below this
      // offset's own bound (ensureAllowance reuses a sufficient
      // approval rather than re-granting one), so any size-based
      // heuristic can zero an authorization another counterparty's
      // acceptance needs. The honest move is to leave the approval
      // alone and TELL the user it is still standing, with the
      // wallet's approvals view as the remedy — the r1 finding
      // (silence about a lingering payoff-sized approval) is answered
      // by the disclosure, not by a guess about ownership.
      onDone(copy.offset.cancelledApprovalKept);
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
      // `state` is a POLL result: another device may have cancelled or
      // completed the offset since, and a keeper term change can make
      // the cached completionBound stale. Re-read the live lock and
      // loan before granting a payoff-sized allowance, so we never
      // approve for a commitment that no longer exists — nor restore
      // an amount that is already short (Codex #1500 r5).
      const [lockRaw, live] = await Promise.all([
        publicClient!.readContract({
          address: walletChain.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'positionLock',
          args: [BigInt(borrowerTokenId)],
        }) as Promise<number | bigint>,
        readLoanLive(publicClient!, walletChain.diamondAddress, loanId),
      ]);
      if (Number(lockRaw) !== LOCK_PRECLOSE_OFFSET) {
        setError(copy.offset.restoreNoLongerLive);
        void queryClient.invalidateQueries({ queryKey: ['offsetPending'] });
        return;
      }
      if (live.status !== LOAN_STATUS_ACTIVE) {
        setError(copy.offset.restoreLoanClosed);
        void queryClient.invalidateQueries({ queryKey: ['offsetPending'] });
        return;
      }
      await ensureAllowance({
        publicClient: publicClient!,
        walletClient: walletClient!,
        token: principalAsset,
        owner: address,
        spender: walletChain.diamondAddress,
        // Sized from the LIVE loan, not the polled snapshot.
        amount: offsetCompletionBoundOf(live),
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
