/**
 * Borrower refinance — the T-092-H tagged-atomic path, advanced mode.
 * FORM ONLY: the pending request's standing surface (banner, funding
 * watch, cancel) is the page-owned RefinancePendingCard, driven by
 * useRefinancePending — a live request must outlive this card's
 * mount gates.
 *
 * The borrower posts a refinance-tagged Borrower offer for EXACTLY
 * the old loan's principal, with the old collateral's identity
 * repeated so it CARRIES OVER (nothing is pulled at create; the lien
 * re-tags old→new inside the lender's accept). The moment any lender
 * accepts, one transaction: new loan opens → old lender is paid
 * principal + full-term remaining interest from the borrower's
 * wallet (via the standing approval set here) → old loan closes →
 * collateral moves.
 *
 * CARRY-OVER BINDS TO THE ORIGINAL BORROWER: the contract's
 * carry-over predicate compares the offer creator to the borrower
 * stored at loan init, NOT the current position-NFT holder. For a
 * transferred position the same offer would silently become a FRESH
 * collateral pledge pulled from the poster's wallet — so this
 * surface is only offered when the connected wallet IS the original
 * borrower (parent gate on the indexed row + a live re-check at
 * submit).
 *
 * Three wallet steps behind ONE reviewed confirm:
 *   1. setAutoRefinanceCaps — on-chain guardrails at the reviewed
 *      rate ceiling and end-date window (skipped when already
 *      sufficient; the request's OWN expiry is what bounds its
 *      lifetime, so looser pre-existing caps are harmless).
 *   2. Standing approval on the old principal asset for the payoff
 *      (exact; the pull only shrinks as partials settle interest).
 *   3. createOffer with the refinance tag and a hard `expiresAt` at
 *      the disclosed request lifetime.
 * If the user abandons the sequence after step 2, the approval is
 * best-effort revoked — a payoff-sized authorization must not linger
 * behind a pristine form with nothing to cancel.
 */
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { usePublicClient, useWalletClient } from 'wagmi';
import { parseEventLogs } from 'viem';
import { copy } from '../content/copy';
import { isPositiveDecimal, captureTxError } from '../lib/errors';
import { flowDisabled } from '../lib/killSwitch';
import { useActiveChain } from '../chain/useActiveChain';
import { DIAMOND_ABI_VIEM, useDiamondWrite } from '../contracts/diamond';
import { ensureAllowance, revokeAllowance } from '../contracts/erc20';
import {
  assertAssetNotPausedLive,
  assertErc20BalanceLive,
  assertPositionNftHeldLive,
  readGraceSecondsLive,
} from '../contracts/preflights';
import {
  loanEndTimeOf,
  LOAN_STATUS_ACTIVE,
  readLoanLive,
  refinanceApprovalOf,
  refinancePayoffOf,
  type LoanLive,
} from '../contracts/loanLive';
import { assertWalletNotSanctionedLive } from '../data/sanctions';
import { readLiveProtocolFees, useProtocolFees } from '../data/fees';
import type { IndexedLoan } from '../data/indexer';
import {
  MAX_INTEREST_BPS,
  percentToBps,
  toRefinanceOfferPayload,
} from '../lib/offerSchema';
import {
  formatBpsAsPercent,
  formatDate,
  formatTokenAmount,
} from '../lib/format';
import { ConfirmReceipt } from './ConfirmReceipt';
import type { TokenMeta } from '../contracts/erc20';

/** The request's on-chain lifetime (its `expiresAt`), and the extra
 *  headroom the caps' end-date window carries past the new-loan
 *  duration. Disclosed in the review; enforced by the OFFER's own
 *  expiry (accept refuses an expired offer), so it holds even when
 *  looser caps pre-exist. */
const REQUEST_WINDOW_DAYS = 30n;

export function RefinanceFlow({
  row,
  live,
  chainNow,
  graceSeconds,
  principalMeta,
  confirmOpen,
  onOpenConfirm,
  onCloseConfirm,
  onPosted,
  busy,
  setBusy,
}: {
  row: IndexedLoan;
  live: LoanLive;
  /** Chain time from the parent's live query — maturity gates never
   *  trust the device clock. */
  chainNow: bigint;
  /** The loan's grace window (parent's cached bucket read). Undefined
   *  while loading — the render gate then degrades to the pre-grace
   *  boundary (conservative; submit re-reads the bucket live). */
  graceSeconds: bigint | undefined;
  principalMeta: TokenMeta;
  /** Page-wide single-confirm-surface slot (see PositionDetails). */
  confirmOpen: boolean;
  onOpenConfirm: () => void;
  onCloseConfirm: () => void;
  /** Hands the created offer id to the page-owned pending state. */
  onPosted: (offerId: string) => void;
  /** The PAGE's shared write lock — the posting sequence spans up to
   *  three wallet confirmations, and the sibling repay-family
   *  buttons must not stay live underneath it. */
  busy: boolean;
  setBusy: (b: boolean) => void;
}) {
  const { address, walletChain, onSupportedChain } = useActiveChain();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });
  const { write } = useDiamondWrite();
  const queryClient = useQueryClient();
  const fees = useProtocolFees();

  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  // Defaults seed from the loan being replaced — the natural starting
  // point for "same loan, better terms".
  const [rateInput, setRateInput] = useState(
    () => String(Number(live.interestRateBps) / 100),
  );
  const [durationInput, setDurationInput] = useState(() =>
    String(row.durationDays),
  );
  const [consent, setConsent] = useState(false);

  // Any term edit voids a previously ticked acknowledgement — the
  // page-wide consent rule (consent covers exactly what was reviewed).
  function setTerm(setter: (v: string) => void, value: string) {
    setter(value);
    setConsent(false);
    onCloseConfirm();
  }

  // ---- Derived figures (display; submit re-reads live) -------------
  // #1189/#1236 — the payoff is time-aware: past maturity it carries
  // the grace-window late fee the accept-time pull now includes.
  const payoff = refinancePayoffOf(live, chainNow);
  const payoffInterest = payoff - live.principal;
  const lifWei = (live.principal * BigInt(fees.loanInitiationFeeBps)) / 10_000n;
  // What the wallet must hold SPARE at accept: the payoff is pulled,
  // but the new principal minus LIF arrives in the same tx.
  const walletTopUp = payoffInterest + lifWei;
  // The approval bound: the payoff at the LAST moment this request
  // could be accepted (its own 30-day expiry or the grace end,
  // whichever first) — what the standing approval is sized to, and
  // what the review disclosure is derived from whenever the request's
  // window can cross the due date. While the grace bucket is still
  // unknown the review CANNOT open (Codex #1256 r1): a zero-grace
  // fallback would quote no headroom while submit approves the larger
  // last-fillable bound — an undisclosed figure must never be
  // signable.
  const graceReady = graceSeconds !== undefined;
  const graceSec = graceSeconds ?? 0n;
  const approvalBound = refinanceApprovalOf(live, {
    expiresAt: chainNow + REQUEST_WINDOW_DAYS * 86_400n,
    graceSeconds: graceSec,
  });
  // Disclosed as TOTAL payoff growth, not "late fee" (Codex #1256 r3
  // P3): past maturity the pull grows by the late fee AND the
  // interest that keeps accruing, and the receipt must not label the
  // interest share as a fee.
  const payoffHeadroom = approvalBound - payoff;
  // OfferCreateFacet clamps a refinance request's on-chain expiry to
  // the grace boundary (graceEnd + 1) — when that clamp binds, the
  // honest reviewed lifetime is the grace end, not "30 days after
  // posting" (Codex #1256 r3).
  const graceEndTs = loanEndTimeOf(live) + graceSec;
  const expiryGraceClamped =
    graceReady && graceEndTs + 1n < chainNow + REQUEST_WINDOW_DAYS * 86_400n;

  const rateBps = isPositiveDecimal(rateInput) ? percentToBps(rateInput) : null;
  const durationDays = /^\d+$/.test(durationInput)
    ? parseInt(durationInput, 10)
    : null;
  const durationValid =
    durationDays !== null &&
    durationDays >= 1 &&
    durationDays <= fees.maxOfferDurationDays;
  const rateValid = rateBps !== null && rateBps > 0 && rateBps <= MAX_INTEREST_BPS;

  const sym = principalMeta.symbol;
  const dec = principalMeta.decimals;
  const payoffStr = `${formatTokenAmount(payoff, dec)} ${sym}`;
  const topUpStr = `${formatTokenAmount(walletTopUp, dec)} ${sym}`;
  const headroomStr = `${formatTokenAmount(payoffHeadroom, dec)} ${sym}`;

  // The consent rule covers the FIGURES too: the live-loan prop, the
  // fee config, and the grace bucket refresh in the background, so a
  // payoff/fee quote can change inside an open review — a tick given
  // against the old numbers must not survive.
  useEffect(() => {
    setConsent(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    payoffStr,
    topUpStr,
    headroomStr,
    fees.loanInitiationFeeBps,
    fees.treasuryFeeBps,
  ]);

  // #1189/#1236 — refinance stays valid THROUGH the grace window
  // (the accept charges the late fee there) and is blocked only
  // strictly past it. While the grace bucket is still loading,
  // degrade to the pre-grace boundary (conservative — the form
  // appears once the bucket lands; submit re-reads it live).
  const pastDue = chainNow > loanEndTimeOf(live);
  const pastGrace = chainNow > loanEndTimeOf(live) + graceSec;

  async function submit() {
    // #1028 — a refinance request IS a createOffer: it must respect
    // the same kill switch as the direct post path during an
    // OfferFacet incident. (Refinance is optional — blocking it traps
    // nothing; normal repayment stays open.)
    if (flowDisabled('post-offer')) {
      setError(copy.killSwitch.disabled);
      return;
    }
    if (!address || !walletChain || !walletClient || !publicClient) return;
    if (rateBps === null || durationDays === null) return;
    setBusy(true);
    setError(null);
    // Tracks whether THIS attempt granted the payoff approval, so an
    // abandoned step 3 can unwind it (see header).
    let approvalGranted = false;
    let approvalToken: `0x${string}` | null = null;
    try {
      // createOffer + the accept-time refinance are Tier-1 — live
      // re-screen before anything can mine.
      await assertWalletNotSanctionedLive(
        publicClient,
        walletChain.diamondAddress,
        address,
      );
      // Live state, one round-trip: current holdership (refinance
      // authority follows the borrower NFT), the loan itself (the
      // payload copies its collateral identity VERBATIM — stale
      // values would break carry-over), chain time, the existing
      // guardrails, live fees (the receipt quoted the cached config),
      // and both legs' pause state (asset addresses are immutable on
      // a loan, so the indexed row's addresses are safe here).
      const [, liveLoan, latestBlock, caps, liveFees] = await Promise.all([
        assertPositionNftHeldLive({
          publicClient,
          diamondAddress: walletChain.diamondAddress,
          tokenId: row.borrowerTokenId,
          expectedOwner: address,
        }),
        readLoanLive(publicClient, walletChain.diamondAddress, row.loanId),
        publicClient.getBlock({ blockTag: 'latest' }),
        publicClient.readContract({
          address: walletChain.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getAutoRefinanceCaps',
          args: [BigInt(row.loanId)],
        }) as Promise<{ enabled: boolean; maxRateBps: number; maxNewExpiry: bigint }>,
        readLiveProtocolFees(publicClient, walletChain.diamondAddress),
        assertAssetNotPausedLive({
          publicClient,
          diamondAddress: walletChain.diamondAddress,
          asset: row.lendingAsset as `0x${string}`,
        }),
        assertAssetNotPausedLive({
          publicClient,
          diamondAddress: walletChain.diamondAddress,
          asset: row.collateralAsset as `0x${string}`,
        }),
      ]);
      if (liveLoan.status !== LOAN_STATUS_ACTIVE) {
        setError(copy.errors.loanAlreadySettled);
        return;
      }
      // Carry-over binds to the ORIGINAL borrower (see header) — the
      // parent gate used the indexed row; re-check against the chain.
      if (liveLoan.borrower.toLowerCase() !== address.toLowerCase()) {
        setError(copy.errors.refinanceNotOriginalBorrower);
        return;
      }
      // #1189/#1236 — the admission gate blocks only STRICTLY past
      // the grace window (a fresh in-grace request is valid; its
      // accept charges the late fee). Judged on the LIVE term fields
      // and the LIVE grace bucket, mirroring LibAutoRefinanceCheck.
      const graceSecLive = await readGraceSecondsLive({
        publicClient,
        diamondAddress: walletChain.diamondAddress,
        durationDays: Number(liveLoan.durationDays),
      });
      const endTime = liveLoan.startTime + liveLoan.durationDays * 86_400n;
      if (latestBlock.timestamp > endTime + graceSecLive) {
        setError(copy.errors.refinancePastGrace);
        return;
      }
      // The receipt quoted the CACHED fee config — a governance retune
      // inside its window must force a re-review, not a silent drift
      // between the quoted fees and the enforced ones.
      if (
        liveFees.treasuryFeeBps !== fees.treasuryFeeBps ||
        liveFees.loanInitiationFeeBps !== fees.loanInitiationFeeBps ||
        liveFees.maxOfferDurationDays !== fees.maxOfferDurationDays
      ) {
        void queryClient.invalidateQueries({ queryKey: ['protocolFees'] });
        throw new Error(copy.match.termsChanged);
      }
      // Guardrails: rate ceiling = the reviewed rate; end-date window
      // = accept-time + duration must fit inside it. Only (re)written
      // when the existing caps don't already cover the reviewed terms
      // — the OFFER's own rate ceiling and expiry are what bind the
      // accept, so looser pre-existing caps are harmless.
      const neededExpiry =
        latestBlock.timestamp +
        (BigInt(durationDays) + REQUEST_WINDOW_DAYS) * 86_400n;
      if (
        !caps.enabled ||
        Number(caps.maxRateBps) < rateBps ||
        caps.maxNewExpiry < neededExpiry
      ) {
        await write('setAutoRefinanceCaps', [
          BigInt(row.loanId),
          true,
          rateBps,
          neededExpiry,
        ]);
      }
      // Standing approval for the accept-time payoff pull — computed
      // from the LIVE loan at the request's LAST fillable moment
      // (its own expiry or the grace end, whichever first). Since
      // #1189 the pull GROWS past maturity by the grace-window late
      // fee, so an approval of today's figure would strand an
      // otherwise-valid request the moment the loan crosses its due
      // date (#1236); this bound is still exact against the maximum
      // the contract can ever pull for THIS request.
      const requestExpiry =
        latestBlock.timestamp + REQUEST_WINDOW_DAYS * 86_400n;
      const livePayoff = refinancePayoffOf(liveLoan, latestBlock.timestamp);
      const liveApproval = refinanceApprovalOf(liveLoan, {
        expiresAt: requestExpiry,
        graceSeconds: graceSecLive,
      });
      // The receipt disclosed the approval bound from the RENDER-time
      // chain clock — a backgrounded tab freezes it, and submit
      // recomputes from the live block. If the bound GREW (the loan
      // slid toward or past maturity while the receipt sat open),
      // force a re-review instead of signing headroom the reviewed
      // figures never showed (Codex #1256 r3). Shrinkage (a partial
      // settled) is fine — the pull only gets smaller.
      if (liveApproval > approvalBound) {
        void queryClient.invalidateQueries({ queryKey: ['loanLive'] });
        throw new Error(copy.match.termsChanged);
      }
      // The approval itself needs no balance, but a wallet that can't
      // even cover the INTEREST portion today should hear it now, not
      // via a failed accept later. (The principal arrives in the
      // accept tx itself, so only the top-up is checked — with the
      // LIVE fee config, at TODAY's payoff; the pending card's
      // balance watch tracks the figure as any late fee accrues.)
      await assertErc20BalanceLive({
        publicClient,
        token: liveLoan.principalAsset,
        owner: address,
        amount:
          livePayoff - liveLoan.principal +
          (liveLoan.principal * BigInt(liveFees.loanInitiationFeeBps)) / 10_000n,
        symbol: sym,
      });
      // Only a MINED approve tx arms the unwind — when the wallet
      // already held a sufficient allowance (ensureAllowance returns
      // null), that allowance belongs to some other live arrangement
      // (a prior request, a sale listing, a user-managed grant) and a
      // failed step 3 must not zero it out from under that flow.
      const approvalTx = await ensureAllowance({
        publicClient,
        walletClient,
        token: liveLoan.principalAsset,
        owner: address,
        spender: walletChain.diamondAddress,
        amount: liveApproval,
      });
      approvalGranted = approvalTx !== null;
      approvalToken = liveLoan.principalAsset;
      const payload = toRefinanceOfferPayload(liveLoan, row.loanId, {
        rateBpsMax: rateBps,
        durationDays,
        consent,
        // The request's own hard expiry — this is what makes the
        // reviewed lifetime true even when looser caps pre-exist
        // (and the bound the approval above was computed against).
        expiresAt: requestExpiry,
      });
      const { receipt } = await write('createOffer', [payload]);
      const created = parseEventLogs({
        abi: DIAMOND_ABI_VIEM,
        logs: receipt.logs,
        eventName: 'OfferCreated',
      }) as unknown as Array<{ args: { offerId: bigint } }>;
      const offerId = created[0]?.args.offerId;
      if (offerId !== undefined) onPosted(offerId.toString());
      setDone(copy.refinance.done);
      setConsent(false);
      onCloseConfirm();
      void queryClient.invalidateQueries({ queryKey: ['myOffers'] });
    } catch (err) {
      setError(captureTxError(err));
      // No offer was created but the payoff approval mined — unwind
      // it so a rejected step 3 leaves no payoff-sized authorization
      // behind a pristine form with nothing to cancel. Best-effort:
      // a second rejection just leaves the wallet's approvals view
      // as the remedy (the error banner already shows the failure).
      if (approvalGranted && approvalToken) {
        try {
          await revokeAllowance({
            publicClient,
            walletClient,
            token: approvalToken,
            owner: address,
            spender: walletChain.diamondAddress,
          });
        } catch {
          // Leave the submit error as the surfaced failure.
        }
      }
    } finally {
      setBusy(false);
    }
  }

  // ---- Render -------------------------------------------------------
  const walletReady =
    onSupportedChain && Boolean(walletClient) && Boolean(publicClient);

  // Strictly past the grace window (by live chain time + live term):
  // refinance no longer applies — resolution belongs to the default
  // process. (A pending request's surface lives in
  // RefinancePendingCard, which the page keeps mounted regardless.)
  if (pastGrace) return null;

  return (
    <section className="card">
      <h3>{copy.refinance.title}</h3>
      <p className="muted">{copy.refinance.blurb}</p>

      <div>
        {pastDue ? (
          // #1236 — in the grace window the request stays postable,
          // but the payoff figures below now carry the growing late
          // fee. Say so before the review opens.
          <div className="banner banner-warn" role="alert" style={{ marginBottom: 12 }}>
            <span className="banner-body">{copy.refinance.graceNote}</span>
          </div>
        ) : null}
        {live.periodicInterestCadence !== 0 ? (
          <div className="banner banner-warn" role="alert" style={{ marginBottom: 12 }}>
            <span className="banner-body">{copy.refinance.periodicWarning}</span>
          </div>
        ) : null}
        <div className="cluster">
          <label className="field" style={{ flex: 1 }}>
            <span className="field-label">{copy.refinance.rateLabel}</span>
            <input
              className="input"
              inputMode="decimal"
              value={rateInput}
              onChange={(e) => setTerm(setRateInput, e.target.value.trim())}
              aria-label={copy.refinance.rateLabel}
            />
          </label>
          <label className="field" style={{ flex: 1 }}>
            <span className="field-label">{copy.refinance.durationLabel}</span>
            <input
              className="input"
              inputMode="numeric"
              value={durationInput}
              onChange={(e) => setTerm(setDurationInput, e.target.value.trim())}
              aria-label={copy.refinance.durationLabel}
            />
          </label>
        </div>
        {!durationValid && durationInput !== '' ? (
          <p className="field-hint" style={{ color: 'var(--danger)', marginTop: 8 }}>
            {copy.refinance.durationRange(fees.maxOfferDurationDays)}
          </p>
        ) : null}

        {/* #1028 — kill switch held up front like every other gated
            flow, not just at the final confirm. */}
        {flowDisabled('post-offer') ? (
          <div className="banner banner-warn" role="alert" style={{ marginTop: 12 }}>
            <span className="banner-body">{copy.killSwitch.disabled}</span>
          </div>
        ) : null}
        {!confirmOpen ? (
          <button
            type="button"
            className="btn btn-secondary"
            style={{ marginTop: 12 }}
            disabled={
              busy ||
              !walletReady ||
              !rateValid ||
              !durationValid ||
              !fees.ready ||
              !graceReady ||
              flowDisabled('post-offer')
            }
            onClick={onOpenConfirm}
          >
            {copy.refinance.action}
          </button>
        ) : (
          <div style={{ marginTop: 16 }}>
            <label className="cluster" style={{ marginBottom: 12, alignItems: 'flex-start' }}>
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                style={{ marginTop: 4 }}
              />
              <span>{copy.refinance.consentLabel}</span>
            </label>
            <ConfirmReceipt
              busy={busy}
              confirmLabel={copy.refinance.confirm}
              onBack={onCloseConfirm}
              onConfirm={() => void submit()}
              // graceReady here too: the bucket query can refresh to
              // undefined (chain hop) while this receipt is open.
              disabled={
                !walletReady ||
                !consent ||
                !graceReady ||
                flowDisabled('post-offer')
              }
              data={{
                youReceive: copy.refinance.receiptReceive,
                youLock: copy.refinance.receiptLock,
                youMayOwe: `${copy.refinance.receiptYouMayOwe(payoffStr)} ${copy.refinance.payoffNote} ${
                  payoffHeadroom > 0n
                    ? `${copy.refinance.lateFeeDisclosure(headroomStr)} `
                    : ''
                }${copy.refinance.walletNote(topUpStr)}`,
                youCanLose: copy.refinance.shortIsSafe,
                fees: `${copy.fees.borrowerLIF(formatBpsAsPercent(fees.loanInitiationFeeBps))} ${copy.refinance.feesTreasuryNote(formatBpsAsPercent(fees.treasuryFeeBps))}`,
                whenThisEnds: `${copy.refinance.whenEndsComposed(
                  expiryGraceClamped
                    ? copy.refinance.expiresAtGraceEnd(formatDate(Number(graceEndTs)))
                    : copy.refinance.expiresAfterDays(Number(REQUEST_WINDOW_DAYS)),
                )} ${copy.refinance.guardrailNote}`,
              }}
            >
              {live.periodicInterestCadence !== 0 ? (
                <div className="banner banner-warn" role="alert" style={{ marginBottom: 12 }}>
                  <span className="banner-body">{copy.refinance.cadenceChangeNote}</span>
                </div>
              ) : null}
              <p className="muted" style={{ marginBottom: 12 }}>
                {copy.refinance.multiStepNote}
              </p>
            </ConfirmReceipt>
          </div>
        )}
      </div>

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
