/**
 * The live refinance request's standing surface — rendered by the
 * page whenever the pending marker exists, INDEPENDENT of the
 * strategy-card gates (mode, loanLive readiness, sanctions state,
 * loan status, maturity). A live request must keep its banner and
 * cancel affordance through all of those windows; this card is also
 * the unwind path once the loan settles some other way (the request
 * then only expires).
 *
 * #1558 — the request's payoff is paid through its single-use payoff
 * permit. When the permit is missing, spent, expired, lapses before the
 * request or is too small, or the wallet's approval of Permit2 no longer
 * covers it, the card says which and offers to sign a new one. Cancelling
 * leaves nothing approved to the protocol. BRIDGE (#3074): on a Diamond
 * deployed before #1558 the payoff is paid from a standing approval of the
 * Diamond; the card then restores that approval, and cancelling also
 * removes it.
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
import { DIAMOND_ABI_VIEM, useDiamondWrite, useTermsBlockNonExitWrites } from '../contracts/diamond';
import { ensureAllowance, revokeAllowance, type TokenMeta } from '../contracts/erc20';
import {
  loanEndTimeOf,
  LOAN_STATUS_ACTIVE,
  readLoanLive,
  refinanceApprovalOf,
} from '../contracts/loanLive';
import {
  attachRefinancePayoffPermit,
  readPayoffQuote,
} from '../contracts/refinancePayoffPermit';
import { readGraceSecondsLive } from '../contracts/preflights';
import type { PermitAttachProgress, RefinancePendingState } from '../data/refinancePending';
import { useAutoRefinancePosture } from '../data/protocol';
import { AutoMatchPostureBanner } from './AutoMatchPostureBanner';
import { ZERO_ADDRESS } from '../lib/offerSchema';
import { cancelRevokesApproval } from '../data/refinanceInterlock';
import { formatDate, formatTokenAmountExact } from '../lib/format';

export function RefinancePendingCard({
  loanId,
  offerId,
  state,
  attachProgress,
  onPermitAttach,
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
  /** #1558 review — the payoff permit's signing and attach progress for
   *  THIS request, held by the page: the request form that posted it has
   *  unmounted by the time the permit is attached, so this card is where
   *  the outcome is shown. Null when nothing is in progress or reported. */
  attachProgress: PermitAttachProgress | null;
  onPermitAttach: (progress: PermitAttachProgress) => void;
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
  const termsVerdict = useTermsBlockNonExitWrites();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  // #2349 — state the automatic-matching posture while the request can
  // still fill (every posture, never silence — #2355 r5). Hidden only once
  // the live read has ESTABLISHED the request is terminal: while that read
  // is loading or failing (`state` undefined) the card is still shown as a
  // pending request, so the posture is stated too (#2355 r7).
  const { posture: autoRefinancePosture } = useAutoRefinancePosture();
  const requestTerminal =
    state !== undefined &&
    (state.accepted ||
      state.expired ||
      !state.loanActive ||
      state.pastGrace ||
      state.untakeable);

  const walletReady =
    onSupportedChain && Boolean(walletClient) && Boolean(publicClient);
  // #1558 review — what the permit's own progress says, and whether it
  // stands in for the chain's permit verdict. While signing, the chain
  // still shows the permit being replaced (or none), so its verdict is not
  // news. A permit sent but unconfirmed, or one that failed to attach, is
  // stated instead of the chain's "missing", which would read as if
  // nothing had happened; any other verdict still shows.
  const signing = attachProgress?.phase === 'signing';
  const progressNote: { tone: 'info' | 'danger'; text: string } | null =
    attachProgress === null
      ? null
      : attachProgress.phase === 'signing'
        ? { tone: 'info', text: copy.refinance.permit.attaching }
        : attachProgress.phase === 'attached'
          ? {
              tone: 'info',
              text: attachProgress.posted
                ? copy.refinance.permit.done
                : copy.refinance.permit.signed,
            }
          : attachProgress.phase === 'unknown'
            ? state?.permitIssue === null
              ? null // the chain now shows it attached
              : { tone: 'info', text: copy.refinance.permit.attachUnconfirmed }
            : {
                tone: 'danger',
                text: copy.refinance.permit.attachFailed(attachProgress.reason),
              };
  const permitVerdictShown =
    !signing &&
    !(
      state?.permitIssue === 'missing' &&
      (attachProgress?.phase === 'unknown' || attachProgress?.phase === 'failed')
    );
  const topUpStr =
    state && principalMeta
      ? `${formatTokenAmountExact(state.topUp, principalMeta.decimals)} ${principalMeta.symbol}`
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
      if (state?.route === 'permit') {
        // #1558 — nothing is approved to the protocol for the payoff: the
        // permit names this request, which no longer exists, so it can
        // never be used.
        outcome = copy.refinance.permit.cancelled;
      } else if (state && !cancelRevokesApproval(state)) {
        // #2429 r3 — a leftover's payoff approval is the SAME approval every
        // refinance request of this wallet on this token draws on, and
        // another may be standing now or be posted from another device at
        // any moment; no read before a separate revoke transaction can rule
        // that out. So cancelling a leftover never revokes: the card says so
        // up front and names the manual removal.
        outcome = copy.refinance.cancelledLeftoverApprovalKept;
      } else try {
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
    // #1961 review round 8 P1 — RESTORE is not cancellation.
    //
    // I left these cards alone last round on the reasoning that their
    // only Diamond write is `cancelOffer`, an exit, so their allowance
    // must serve the cancel. That was wrong: the allowance serves THIS
    // control, which re-funds a pending refinance / offset / sale so a
    // counterparty can complete it. There is no later Diamond write to
    // refuse, so the write gate never sees it — a wallet that had
    // declined the Terms could restore its own funding and let somebody
    // else create the exposure. Cancelling needs no approval and stays
    // available.
    const termsForRestore = termsVerdict();
    if (termsForRestore !== 'ok') {
      setError(
        termsForRestore === 'unknown'
          ? copy.errors.termsCheckUnavailable
          : copy.errors.termsNotAccepted,
      );
      return;
    }
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
      const permitRoute = state?.route === 'permit';
      if (
        offer.creator === ZERO_ADDRESS ||
        offer.accepted ||
        // An expired request is unacceptable on-chain — re-granting a
        // payoff-sized authorization for it is a pure dangling one.
        (offer.expiresAt !== 0n && latestBlock.timestamp >= offer.expiresAt) ||
        latestBlock.timestamp > loanEndTimeOf(liveLoan, latestBlock.timestamp) + graceSec ||
        liveLoan.status !== LOAN_STATUS_ACTIVE
      ) {
        setError(
          permitRoute ? copy.refinance.permit.signAborted : copy.refinance.reapproveAborted,
        );
        void queryClient.invalidateQueries({ queryKey: ['refinancePending'] });
        return;
      }
      if (permitRoute) {
        // #1558 — a new permit for the payoff at the request's last
        // fillable moment, read from the contract, expiring then. It
        // replaces the one attached; the wallet's approval of Permit2 is
        // raised first if it no longer covers it.
        const quote = await readPayoffQuote({
          publicClient,
          diamond: walletChain.diamondAddress,
          live: liveLoan,
          loanId: BigInt(loanId),
          offerId: BigInt(offerId),
          chainNow: latestBlock.timestamp,
          expiresAt: offer.expiresAt,
          graceSeconds: graceSec,
          route: 'permit',
        });
        // Progress and outcome go through the page's record, the one the
        // posting form also reports to, so this card states them by one
        // rule whichever surface signed.
        onPermitAttach({ offerId, phase: 'signing' });
        try {
          const attached = await attachRefinancePayoffPermit({
            publicClient,
            walletClient,
            write,
            chainId: walletChain.chainId,
            diamond: walletChain.diamondAddress,
            owner: address,
            token: liveLoan.principalAsset,
            maxAmount: quote.bound,
            deadline: quote.lastFillable,
            loanId: BigInt(loanId),
            offerId: BigInt(offerId),
          });
          onPermitAttach(
            attached === 'attached'
              ? { offerId, phase: 'attached', posted: false }
              : { offerId, phase: 'unknown' },
          );
        } catch (attachErr) {
          onPermitAttach({ offerId, phase: 'failed', reason: captureTxError(attachErr) });
        }
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
            ? // Codex #2668 r1 — the no-guarantee warning does not wait for
              // the check: an RPC outage could otherwise leave this card up
              // indefinitely without the one lifecycle fact the borrower
              // must not miss. Suppressed only once a state is KNOWN to be
              // terminal, below.
              <>
                {copy.refinance.pendingChecking(offerId)}{' '}
                {copy.refinance.noGuarantee}
              </>
            : state.accepted
              ? copy.refinance.pendingAccepted
              : state.untakeable
                ? // #2425 — not the loan's recorded request: the protocol
                  // will never take it, and it holds nothing back; its cancel
                  // leaves the shared approval in place (#2429 r3).
                  state.route === 'permit'
                  ? copy.refinance.permit.pendingUntakeable
                  : copy.refinance.pendingUntakeable
              : state.expired
                ? (state.route === 'permit'
                    ? copy.refinance.permit.pendingExpired
                    : copy.refinance.pendingExpired)(formatDate(Number(state.expiresAt)))
                : state.pastGrace && state.loanActive
                  ? // #1189 — strictly past the loan's grace window the
                    // admission gate rejects any accept: the request is
                    // as dead as an expired one, so say that instead of
                    // implying a lender could still take it.
                    state.route === 'permit'
                    ? copy.refinance.permit.pendingPastGrace
                    : copy.refinance.pendingPastGrace
                  : (
                <>
                  {copy.refinance.pending(offerId)}{' '}
                  {copy.refinance.pendingExpires(
                    formatDate(Number(state.expiresAt)),
                  )}
                  {state.loanActive && topUpStr ? (
                    <> {copy.refinance.walletNote(topUpStr)}</>
                  ) : null}
                  {/* #544 — still no match guarantee while the request is open. */}
                  {state.loanActive ? <> {copy.refinance.noGuarantee}</> : null}
                  {!state.loanActive ? (
                    <>
                      {' '}
                      {state.route === 'permit'
                        ? copy.refinance.permit.pendingLoanClosed
                        : copy.refinance.pendingLoanClosed}
                    </>
                  ) : null}
                </>
              )}
        </span>
      </div>
      {!requestTerminal ? (
        <AutoMatchPostureBanner posture={autoRefinancePosture} />
      ) : null}
      {progressNote && state?.route !== 'approval' ? (
        <div
          className={`banner ${progressNote.tone === 'danger' ? 'banner-danger' : 'banner-info'}`}
          role={progressNote.tone === 'danger' ? 'alert' : 'status'}
          style={{ marginTop: 12 }}
        >
          <span className="banner-body">{progressNote.text}</span>
        </div>
      ) : null}
      {state?.allowanceShort && state.loanActive && permitVerdictShown ? (
        <div className="banner banner-danger" role="alert" style={{ marginTop: 12 }}>
          <span className="banner-body">
            {state.route === 'permit' && state.permitIssue
              ? copy.refinance.permit.issue[state.permitIssue]
              : copy.refinance.allowanceShort}
          </span>
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
          {state.allowanceShort && state.loanActive && !signing ? (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy || !walletReady}
              onClick={() => void reapprove()}
            >
              {state.route === 'permit' ? copy.refinance.permit.sign : copy.refinance.reapprove}
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
