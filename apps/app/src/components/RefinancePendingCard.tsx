/**
 * The live refinance request's standing surface — rendered by the
 * page whenever the pending marker exists, INDEPENDENT of the
 * strategy-card gates (mode, loanLive readiness, sanctions state,
 * loan status, maturity). A live request must keep its banner and
 * cancel affordance through all of those windows; this card is also
 * the unwind path once the loan settles some other way (the request
 * then only expires — cancelling here also removes the standing
 * payoff approval).
 *
 * Shares the PAGE's busy lock: its writes touch the same token
 * allowance the repay/preclose flows manage, so two in-flight
 * signatures must never race (the one-confirm-surface rule's write
 * half).
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { usePublicClient, useWalletClient } from 'wagmi';
import { copy } from '../content/copy';
import { captureTxError } from '../lib/errors';
import { useActiveChain } from '../chain/useActiveChain';
import { DIAMOND_ABI_VIEM, useDiamondWrite } from '../contracts/diamond';
import { ensureAllowance, revokeAllowance, type TokenMeta } from '../contracts/erc20';
import {
  loanEndTimeOf,
  LOAN_STATUS_ACTIVE,
  readLoanLive,
  refinanceApprovalOf,
} from '../contracts/loanLive';
import { readGraceSecondsLive } from '../contracts/preflights';
import type { RefinancePendingState } from '../data/refinancePending';
import { ZERO_ADDRESS } from '../lib/offerSchema';
import { formatDate, formatTokenAmount } from '../lib/format';

export function RefinancePendingCard({
  loanId,
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
  offerId: string;
  /** Live-verified state from useRefinancePending; undefined while
   *  the verification reads are loading or failing. */
  state: RefinancePendingState | undefined;
  principalAsset: `0x${string}`;
  principalMeta: TokenMeta | undefined;
  /** The PAGE's shared write lock. */
  busy: boolean;
  setBusy: (b: boolean) => void;
  onCleared: () => void;
  /** Routes the cancel outcome to the PAGE banner — clearing the
   *  marker unmounts this card, so a message set locally after the
   *  clear would never be seen. */
  onDone: (message: string) => void;
}) {
  const { address, walletChain, onSupportedChain } = useActiveChain();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });
  const { write } = useDiamondWrite();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const walletReady =
    onSupportedChain && Boolean(walletClient) && Boolean(publicClient);
  const topUpStr =
    state && principalMeta
      ? `${formatTokenAmount(state.topUp, principalMeta.decimals)} ${principalMeta.symbol}`
      : null;

  async function cancelPending() {
    if (!address || !walletChain || !walletClient || !publicClient) return;
    setBusy(true);
    setError(null);
    try {
      await write('cancelOffer', [BigInt(offerId)]);
      void queryClient.invalidateQueries({ queryKey: ['myOffers'] });
      // Unwind the standing payoff approval too — "continues
      // unchanged" must include the wallet's authorizations. Failure
      // here is non-fatal (the cancel already landed): say so. This
      // runs BEFORE the marker clear on purpose: clearing unmounts
      // this card, so the revoke's wallet prompt would otherwise
      // arrive context-free after the explanatory UI vanished, and a
      // rejected revoke would surface nowhere.
      let outcome: string;
      try {
        await revokeAllowance({
          publicClient,
          walletClient,
          token: principalAsset,
          owner: address,
          spender: walletChain.diamondAddress,
        });
        outcome = copy.refinance.cancelled;
      } catch {
        outcome = copy.refinance.cancelledRevokeFailed;
      }
      // Page banner, then clear — the local `done` state dies with
      // the card.
      onDone(outcome);
      onCleared();
    } catch (err) {
      setError(captureTxError(err));
    } finally {
      setBusy(false);
    }
  }

  async function reapprove() {
    if (!address || !walletChain || !walletClient || !publicClient) return;
    setBusy(true);
    setError(null);
    try {
      // The banner's warning is up to 30s stale — verify the request
      // is STILL completable before re-granting a payoff-sized
      // approval (an accepted/cancelled request or a settled loan
      // must not get a fresh dangling authorization).
      const [offer, liveLoan, latestBlock] = await Promise.all([
        publicClient.readContract({
          address: walletChain.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getOfferDetails',
          args: [BigInt(offerId)],
        }) as Promise<{ creator: string; accepted: boolean; expiresAt: bigint }>,
        readLoanLive(publicClient, walletChain.diamondAddress, loanId),
        publicClient.getBlock({ blockTag: 'latest' }),
      ]);
      // Grace bucket read live too: a request whose loan is strictly
      // past its grace window is as unacceptable on-chain as an
      // expired one (#1189 admission gate) — same abort.
      const graceSec = await readGraceSecondsLive({
        publicClient,
        diamondAddress: walletChain.diamondAddress,
        durationDays: Number(liveLoan.durationDays),
      });
      if (
        offer.creator === ZERO_ADDRESS ||
        offer.accepted ||
        // An expired request is unacceptable on-chain — re-granting a
        // payoff-sized approval for it is a pure dangling authorization.
        (offer.expiresAt !== 0n && latestBlock.timestamp >= offer.expiresAt) ||
        latestBlock.timestamp > loanEndTimeOf(liveLoan) + graceSec ||
        liveLoan.status !== LOAN_STATUS_ACTIVE
      ) {
        setError(copy.refinance.reapproveAborted);
        void queryClient.invalidateQueries({ queryKey: ['refinancePending'] });
        return;
      }
      await ensureAllowance({
        publicClient,
        walletClient,
        token: liveLoan.principalAsset,
        owner: address,
        spender: walletChain.diamondAddress,
        // The payoff at the request's LAST fillable moment — a later
        // grace-window accept pulls the late fee too (#1236), and the
        // restored approval must cover it, not just today's figure.
        amount: refinanceApprovalOf(liveLoan, {
          expiresAt: offer.expiresAt,
          graceSeconds: graceSec,
        }),
      });
      setDone(copy.refinance.reapproved);
      void queryClient.invalidateQueries({ queryKey: ['refinancePending'] });
    } catch (err) {
      setError(captureTxError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h3>{copy.refinance.title}</h3>
      <div
        className={`banner ${state?.accepted ? 'banner-info' : 'banner-warn'}`}
        role="status"
      >
        <span className="banner-body">
          {state === undefined
            ? copy.refinance.pendingChecking(offerId)
            : state.accepted
              ? copy.refinance.pendingAccepted
              : state.expired
                ? copy.refinance.pendingExpired(
                    formatDate(Number(state.expiresAt)),
                  )
                : state.pastGrace && state.loanActive
                  ? // #1189 — strictly past the loan's grace window the
                    // admission gate rejects any accept: the request is
                    // as dead as an expired one, so say that instead of
                    // implying a lender could still take it.
                    copy.refinance.pendingPastGrace
                  : (
                <>
                  {copy.refinance.pending(offerId)}{' '}
                  {copy.refinance.pendingExpires(
                    formatDate(Number(state.expiresAt)),
                  )}
                  {state.loanActive && topUpStr ? (
                    <> {copy.refinance.walletNote(topUpStr)}</>
                  ) : null}
                  {!state.loanActive ? (
                    <> {copy.refinance.pendingLoanClosed}</>
                  ) : null}
                </>
              )}
        </span>
      </div>
      {state?.allowanceShort && state.loanActive ? (
        <div className="banner banner-danger" role="alert" style={{ marginTop: 12 }}>
          <span className="banner-body">{copy.refinance.allowanceShort}</span>
        </div>
      ) : null}
      {state?.balanceShort && state.loanActive && topUpStr ? (
        <div className="banner banner-danger" role="alert" style={{ marginTop: 12 }}>
          <span className="banner-body">
            {copy.refinance.balanceShort(topUpStr)}
          </span>
        </div>
      ) : null}
      {state && !state.accepted ? (
        <div className="cluster" style={{ marginTop: 12 }}>
          <button
            type="button"
            className="btn btn-secondary"
            // Chain-time cooldown gate — a click before it elapses
            // reverts on-chain. While state is loading, stay disabled
            // rather than invite a doomed click.
            disabled={busy || !walletReady || !state.cancelUnlocked}
            onClick={() => void cancelPending()}
          >
            {copy.refinance.cancel}
          </button>
          {state.allowanceShort && state.loanActive ? (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy || !walletReady}
              onClick={() => void reapprove()}
            >
              {copy.refinance.reapprove}
            </button>
          ) : null}
        </div>
      ) : null}
      {state && !state.accepted && !state.cancelUnlocked ? (
        <p className="field-hint" style={{ marginTop: 8 }}>
          {copy.refinance.cancelSoon}
        </p>
      ) : null}
      {done ? (
        <div className="banner banner-info" role="status" style={{ marginTop: 12 }}>
          <span className="banner-body">{done}</span>
        </div>
      ) : null}
      {error ? (
        <div className="banner banner-danger" role="alert" style={{ marginTop: 12 }}>
          <span className="banner-body">{error}</span>
        </div>
      ) : null}
    </section>
  );
}
