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
 * wallet (through the request's payoff permit, #1558) → old loan
 * closes → collateral moves.
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
 * The wallet steps behind ONE reviewed confirm (#1558):
 *   1. setAutoRefinanceCaps — on-chain guardrails at the reviewed
 *      rate ceiling and end-date window (skipped when already
 *      sufficient; the request's OWN expiry is what bounds its
 *      lifetime, so looser pre-existing caps are harmless).
 *   2. The wallet's ERC-20 approval of Permit2, when it does not
 *      already cover the bound. It moves nothing without a signature,
 *      so an abandoned sequence leaves nothing to unwind.
 *   3. createOffer with the refinance tag and a hard `expiresAt` at
 *      the disclosed request lifetime.
 *   4. The payoff permit: a signature for exactly the reviewed bound,
 *      bound to this loan through this request and expiring with it,
 *      then the transaction that attaches it. A request posted without
 *      it stands but cannot complete; its card offers to sign.
 *
 * The permit is the only payoff route (#3074): the standing approval of
 * the Diamond that Diamonds deployed before #1558 needed, and its unwind,
 * are gone.
 */
import { useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { usePublicClient, useWalletClient } from 'wagmi';
import { parseEventLogs } from 'viem';
import { copy } from '../content/copy';
import { isPositiveDecimal, captureTxError } from '../lib/errors';
import { flowDisabled } from '../lib/killSwitch';
import { useActiveChain } from '../chain/useActiveChain';
import { DIAMOND_ABI_VIEM, useDiamondWrite, useTermsBlockNonExitWrites } from '../contracts/diamond';
import { TxNotSettledError } from '../contracts/ownReceipt';
import { assertErc20BalanceLive } from '../contracts/preflights';
import { readTxValidUntil } from '../contracts/txDeadline';
import { graceEndOf, loanEndTimeOf, verifiablyPastGrace, type LoanLive } from '../contracts/loanLive';
import type { PermitAttachProgress } from '../data/refinancePending';
import {
  attachRefinancePayoffPermit,
  ensurePermit2Approval,
  permitNeeded,
  readPayoffQuote,
} from '../contracts/refinancePayoffPermit';
import { useProtocolFees } from '../data/fees';
import { formatLifRate } from '../lib/initiationFee';
import {
  REQUEST_WINDOW_DAYS,
  checkRefinanceRequest,
  reviewedBoundMoved,
  refinanceStatements,
} from '../data/refinancePlan';
import { useAutoRefinancePosture } from '../data/protocol';
import { AutoMatchPostureBanner } from './AutoMatchPostureBanner';
import type { IndexedLoan } from '../data/indexer';
import { MAX_INTEREST_BPS, percentToBps } from '../lib/offerSchema';
import {
  formatBpsAsPercent,
  formatTokenAmountExact,
} from '../lib/format';
import { ConfirmReceipt } from './ConfirmReceipt';
import { useReviewConsent } from '../hooks/useReviewConsent';
import { ConsentWithdrawnNote } from './ConsentWithdrawnNote';
import type { TokenMeta } from '../contracts/erc20';

export function RefinanceFlow({
  preSubmitBlock,
  row,
  live,
  chainNow,
  graceSeconds,
  principalMeta,
  confirmOpen,
  onOpenConfirm,
  onCloseConfirm,
  onPosted,
  onPermitAttach,
  busy,
  setBusy,
}: {
  /** Optional page-supplied gate run LIVE at submit start — returns a
   *  user-facing message to block on (e.g. the accepted-sale
   *  completion pause, Codex #1511 r5 P1) or null to proceed. */
  preSubmitBlock?: () => Promise<string | null>;
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
  /** #1558 review — reports the payoff permit's signing and attach
   *  progress to the PAGE. Posting the request unmounts this form (the
   *  pending card takes over), so the outcome is shown there, never here. */
  onPermitAttach: (progress: PermitAttachProgress) => void;
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
  const termsVerdict = useTermsBlockNonExitWrites();
  const queryClient = useQueryClient();
  const fees = useProtocolFees();
  const { posture: autoRefinancePosture } = useAutoRefinancePosture();

  const [error, setError] = useState<string | null>(null);
  // Defaults seed from the loan being replaced — the natural starting
  // point for "same loan, better terms".
  const [rateInput, setRateInput] = useState(
    () => String(Number(live.interestRateBps) / 100),
  );
  const [durationInput, setDurationInput] = useState(() =>
    String(row.durationDays),
  );
  // A term edit closes the open review; the consent it carried clears
  // with the reviewed values below (#1696).
  function setTerm(setter: (v: string) => void, value: string) {
    setter(value);
    onCloseConfirm();
  }

  // ---- Derived figures (display; submit re-reads live) -------------
  // The bound: the payoff at the LAST moment this request could be
  // accepted (its own 30-day expiry or the grace end, whichever first)
  // — what the permit is signed for, and what the review disclosure is
  // derived from whenever the request's window can cross the due date.
  // While the grace bucket is still unknown the review CANNOT open
  // (Codex #1256 r1): a zero-grace fallback would quote no headroom while
  // submit signs for the larger last-fillable bound — an undisclosed
  // figure must never be signable.
  const graceReady = graceSeconds !== undefined;
  const graceSec = graceSeconds ?? 0n;
  // #1558 — the payoff now and the bound come from the contract
  // (`getRefinancePayoff`), so the figures reviewed are the figures the
  // permit is signed for. Kept on screen while a newer block's figures
  // load, so a refresh does not close an open review. The quote carries
  // the request expiry it was computed at (#3311): with
  // `keepPreviousData` the figures on screen can belong to an older block
  // than `chainNow`, and the send must check — and post — the request
  // THOSE figures describe.
  // The request's term: the initiation fee is sized at it (#3649).
  const durationDays = /^\d+$/.test(durationInput)
    ? parseInt(durationInput, 10)
    : null;
  const quoteQuery = useQuery({
    queryKey: [
      'refinancePayoffQuote',
      walletChain?.chainId,
      row.loanId,
      String(chainNow),
      String(graceSec),
      String(live.readAtTimestamp),
    ],
    // The contract sizes the wallet's share under the live fee rule.
    enabled: Boolean(publicClient && walletChain) && graceReady,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const requestExpiry = chainNow + REQUEST_WINDOW_DAYS * 86_400n;
      const q = await readPayoffQuote({
        publicClient: publicClient!,
        diamond: walletChain!.diamondAddress,
        live,
        loanId: BigInt(row.loanId),
        offerId: 0n,
        chainNow,
        expiresAt: requestExpiry,
        graceSeconds: graceSec,
      });
      return { ...q, requestExpiry };
    },
  });
  const quote = quoteQuery.data;
  const quoteReady = quote !== undefined;
  // #1189/#1236 — the payoff is time-aware: past maturity it carries
  // the grace-window late fee the accept-time pull now includes.
  const payoff = quote?.payoff ?? 0n;
  const payoffBound = quote?.bound ?? 0n;
  // #3042 — what the wallet must hold SPARE at accept: the payoff less
  // the new loan's net principal (the payoff's interest plus the new
  // loan's initiation fee). This is the contract's own figure and
  // exactly what is pulled.
  const walletTopUp = quote?.topUp ?? 0n;
  // Disclosed as TOTAL payoff growth, not "late fee" (Codex #1256 r3
  // P3): past maturity the pull grows by the late fee AND the
  // interest that keeps accruing, and the receipt must not label the
  // interest share as a fee.
  const payoffHeadroom = quote?.growth ?? 0n;
  // OfferCreateFacet clamps a refinance request's on-chain expiry to
  // the grace boundary (graceEnd + 1) — when that clamp binds, the
  // honest reviewed lifetime is the grace end, not "30 days after this
  // review" (Codex #1256 r3; the window counts from the review, #3311).
  // #3525 — the chain's grace end, moved by a sequencer outage window.
  const graceEndTs = graceEndOf(live, graceSec, chainNow).graceEnd;
  // The expiry of the request the figures on screen describe (#3311).
  const reviewedExpiry = quote?.requestExpiry ?? chainNow + REQUEST_WINDOW_DAYS * 86_400n;
  const expiryGraceClamped = graceReady && graceEndTs + 1n < reviewedExpiry;

  const rateBps = isPositiveDecimal(rateInput) ? percentToBps(rateInput) : null;
  const durationValid =
    durationDays !== null &&
    durationDays >= 1 &&
    durationDays <= fees.maxOfferDurationDays;
  const rateValid = rateBps !== null && rateBps > 0 && rateBps <= MAX_INTEREST_BPS;

  // #3649 — the initiation fee's rate at the REQUEST's term (the new
  // loan's), from the live rule; '…' until it is read.
  const lifPct =
    fees.lifTerms && durationDays !== null ? formatLifRate(fees.lifTerms, durationDays) : '…';

  const sym = principalMeta.symbol;
  const dec = principalMeta.decimals;
  const payoffStr = `${formatTokenAmountExact(payoff, dec)} ${sym}`;
  const topUpStr = `${formatTokenAmountExact(walletTopUp, dec)} ${sym}`;
  const headroomStr = `${formatTokenAmountExact(payoffHeadroom, dec)} ${sym}`;
  const boundStr = `${formatTokenAmountExact(payoffBound, dec)} ${sym}`;

  // Consent covers exactly what was reviewed (#1696): the terms the user
  // set, and the figures the live-loan prop, the fee config and the grace
  // bucket refresh in the background, so a payoff or fee quote can change
  // inside an open review. Keyed on the values, cleared in the same render.
  const consent = useReviewConsent([
    row.loanId,
    rateBps,
    durationDays,
    payoff,
    payoffBound,
    walletTopUp,
    payoffHeadroom,
    lifPct,
    fees.treasuryFeeBps,
    graceReady,
    expiryGraceClamped,
    graceEndTs,
    live.periodicInterestCadence,
    principalMeta.symbol,
    principalMeta.decimals,
    address,
    walletChain?.chainId,
  ]);

  // #1189/#1236 — refinance stays valid THROUGH the grace window
  // (the accept charges the late fee there) and is blocked only
  // strictly past it. While the grace bucket is still loading,
  // degrade to the pre-grace boundary (conservative — the form
  // appears once the bucket lands; submit re-reads it live).
  const pastDue = chainNow > loanEndTimeOf(live, chainNow);
  const pastGrace = verifiablyPastGrace(live, graceSec, chainNow);
  // The loan-dependent statements, from the one source the batch review
  // reads too.
  const statements = refinanceStatements({
    pastDue,
    periodic: live.periodicInterestCadence !== 0,
    expiryGraceClamped,
    graceEnd: graceEndTs,
  });

  async function submit() {
    // Page-supplied settlement gate (Codex #1511 r5 P1) — a LIVE
    // accepted-sale re-check immediately before any write that would
    // settle or rewrite the loan under a funded acceptance.
    if (preSubmitBlock) {
      if (busy) return;
      // Hold the shared lock ACROSS the await (Codex #1511 r6): with
      // the old await-then-lock ordering a slow probe left Confirm/
      // Back live and un-mutexed. Released before falling through —
      // the continuation to this flow's own lock acquisition is
      // synchronous, so nothing can interleave.
      setBusy(true);
      const blockedMsg = await preSubmitBlock();
      setBusy(false);
      if (blockedMsg) {
        setError(blockedMsg);
        return;
      }
    }
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
    // The request is posted with consent given (the plan's payload);
    // the confirm button is held until the box is ticked.
    if (!consent.given) return;
    setBusy(true);
    setError(null);
    // Hash of the createOffer transaction once submitted, so a failure
    // after it can tell a request that may be live from one that is not.
    let createOfferTx: `0x${string}` | null = null;
    try {
      // The live checks and the request they produce, shared with the
      // "Refinance all" batch on Positions (#126 slice 3): sanctions, the
      // borrower position still held, both assets unpaused, the loan
      // Active and still in or before its grace window, the ORIGINAL
      // borrower (see header), the reviewed fee config, the guardrails the
      // request needs, and the payoff permit's bound at the request's last
      // fillable moment. Read failures throw.
      //
      // #3311 — judged at the REVIEWED request: its expiry is the one the
      // receipt's figures were quoted at, so the bound below is compared
      // at the same deadline, and the request posts with that expiry. A
      // review too old in chain time is refused there (re-review).
      if (!quote || !fees.lifTerms) throw new Error(copy.match.termsChanged);
      const plan = await checkRefinanceRequest(
        { publicClient, diamond: walletChain.diamondAddress, holder: address },
        row,
        { rateBps, durationDays },
        { ...fees, lifTerms: fees.lifTerms },
        { requestExpiry: quote.requestExpiry },
      );
      if (plan.kind === 'refused') {
        if (plan.feesMoved) {
          // The receipt quoted the CACHED fee config — a governance retune
          // inside its window forces a re-review.
          void queryClient.invalidateQueries({ queryKey: ['protocolFees'] });
          throw new Error(plan.reason);
        }
        // Refresh what the receipt shows, so a re-review (a stale one
        // above all, #3311) quotes the current block.
        void queryClient.invalidateQueries({ queryKey: ['loanLive'] });
        void queryClient.invalidateQueries({ queryKey: ['refinancePayoffQuote'] });
        setError(plan.reason);
        return;
      }
      const { liveLoan } = plan;
      // The plan is judged at the live block for the SAME request the
      // receipt described (#3311), so its bound differs from the reviewed
      // one only when something real moved: the loan itself (a late fee,
      // a changed position) or the fee rate. If the bound GREW, force a
      // re-review instead of signing what the reviewed
      // figures never showed (Codex #1256 r3). Shrinkage (a partial
      // settled) is fine — the pull only gets smaller. Checked before any
      // write.
      if (reviewedBoundMoved(plan, quote)) {
        void queryClient.invalidateQueries({ queryKey: ['loanLive'] });
        void queryClient.invalidateQueries({ queryKey: ['refinancePayoffQuote'] });
        throw new Error(copy.match.termsChanged);
      }
      // Guardrails at the reviewed rate ceiling and end-date window,
      // written only when the existing caps don't already cover them.
      if (plan.caps) {
        await write('setAutoRefinanceCaps', [
          BigInt(row.loanId),
          true,
          plan.caps.rateBps,
          plan.caps.maxNewExpiry,
        ]);
      }
      // The authorisation itself needs no balance, but a wallet that can't
      // even cover the INTEREST portion today should hear it now, not
      // via a failed accept later. (The new loan's net principal pays
      // the old lender inside the accept, #3042, so only the top-up is
      // checked — with the LIVE fee config, at TODAY's payoff; the pending card's
      // balance watch tracks the figure as any late fee accrues.)
      await assertErc20BalanceLive({
        publicClient,
        token: liveLoan.principalAsset,
        owner: address,
        amount: plan.topUp,
        symbol: sym,
      });
      // #1961 — refuse BEFORE the allowance, not after. This flow lives
      // on `/positions/:loanId`, which the Terms gate exempts so a held
      // user can repay; its Diamond write is NOT an exit, so
      // `useDiamondWrite` would reject it — but only once the user had
      // paid for an approval they cannot use. Same defect Codex found
      // on `/vpfi`, the desk ticket and the desk amend; swept here
      // rather than waiting for it to be reported a fourth time.
      const termsForFlow = termsVerdict();
      if (termsForFlow !== 'ok') {
        throw new Error(
          termsForFlow === 'unknown'
            ? copy.errors.termsCheckUnavailable
            : copy.errors.termsNotAccepted,
        );
      }
      // #1558 — the wallet's approval of Permit2 covers the bound. It
      // moves nothing without the permit signed below, so nothing here is
      // unwound if the sequence stops.
      await ensurePermit2Approval({
        publicClient,
        walletClient,
        owner: address,
        token: liveLoan.principalAsset,
        maxAmount: plan.bound,
      });
      // The request itself, with its own hard expiry — what makes the
      // reviewed lifetime true even when looser caps pre-exist, and the
      // moment the bound above was computed for.
      const payload = plan.payload;
      // LATE re-gate (Codex #1511 r10 P1) — see the entry gate note.
      if (preSubmitBlock) {
        const blockedLate = await preSubmitBlock();
        if (blockedLate) {
          // Only the Permit2 approval may have mined above, and it moves
          // nothing without a signature, so there is nothing to unwind.
          setError(blockedLate);
          return;
        }
      }
      // The transaction deadline (#3412), read from chain time at the send.
      // Distinct from the request's own expiry above: this bounds when the
      // POSTING may land, that bounds how long the request stays fillable.
      const validUntil = await readTxValidUntil(publicClient);
      const { receipt } = await write('createOffer', [payload, validUntil], {
        onSubmitted: (hash) => {
          createOfferTx = hash;
        },
      });
      const created = parseEventLogs({
        abi: DIAMOND_ABI_VIEM,
        logs: receipt.logs,
        eventName: 'OfferCreated',
      }) as unknown as Array<{ args: { offerId: bigint } }>;
      const offerId = created[0]?.args.offerId;
      if (offerId !== undefined) onPosted(offerId.toString());
      consent.clear();
      onCloseConfirm();
      void queryClient.invalidateQueries({ queryKey: ['myOffers'] });
      // #1558 — the payoff permit names the request, so it is signed
      // once the request exists: exactly the reviewed bound, expiring
      // at the request's last fillable moment. The request is already
      // posted, so a failure here is reported as that, never as a
      // failed post. Posting unmounted this form, so every outcome goes
      // to the page-owned pending card (#1558 review), which also offers
      // to sign again.
      if (offerId === undefined) {
        // No request id to name, and so no card: this form is still
        // mounted and says so itself.
        setError(`${copy.refinance.permit.postedWithoutPermit} ${copy.errors.checkRetry}`);
        return;
      }
      const id = offerId.toString();
      onPermitAttach({ offerId: id, phase: 'signing' });
      try {
        const attached = await attachRefinancePayoffPermit({
          publicClient,
          walletClient,
          write,
          chainId: walletChain.chainId,
          diamond: walletChain.diamondAddress,
          owner: address,
          token: liveLoan.principalAsset,
          maxAmount: plan.bound,
          deadline: plan.permitDeadline,
          loanId: BigInt(row.loanId),
          offerId,
        });
        // A permit sent but not yet confirmed may still attach: the card
        // says so, never "attached" and never "missing".
        onPermitAttach(
          attached === 'attached'
            ? { offerId: id, phase: 'attached', posted: true }
            : attached === 'notNeeded'
              ? { offerId: id, phase: 'notNeeded' }
              : { offerId: id, phase: 'unknown' },
        );
      } catch (attachErr) {
        onPermitAttach({ offerId: id, phase: 'failed', reason: captureTxError(attachErr) });
      }
      void queryClient.invalidateQueries({ queryKey: ['refinancePending'] });
    } catch (err) {
      setError(captureTxError(err));
      // A failure after the request was submitted may still leave it live
      // on chain (a lost receipt), so say so rather than imply nothing was
      // posted. Cancelled, replaced or reverted: no request exists.
      const offerMayExist = await (async () => {
        if (createOfferTx === null) return false; // never submitted
        // A settlement failure is POSITIVE evidence, and it is the whole
        // reason the error carries a reason at all. Cancelled or
        // replaced: our call never executed, so no offer exists.
        // Reverted: it executed and produced nothing. None of them can be
        // recovered from a receipt lookup — a cancelled transaction's own
        // hash has no receipt (#1529 review round 12).
        if (err instanceof TxNotSettledError) return false;
        try {
          const r = await publicClient.getTransactionReceipt({ hash: createOfferTx });
          return r.status === 'success';
        } catch {
          return true; // cannot tell — assume it landed
        }
      })();
      if (offerMayExist) setError(copy.refinance.permit.postedButUnconfirmed);
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
      {/* #544 — a request is not a match: the loan's due date and default
          rules stand until a lender accepts. Always visible on the form. */}
      <div className="banner banner-info" style={{ marginBottom: 12 }}>
        <span className="banner-body">{copy.refinance.noGuarantee}</span>
      </div>

      <div>
        {statements.pastDue ? (
          // #1236 — in the grace window the request stays postable,
          // but the payoff figures below now carry the growing late
          // fee. Say so before the review opens.
          <div className="banner banner-warn" role="alert" style={{ marginBottom: 12 }}>
            <span className="banner-body">{statements.pastDue}</span>
          </div>
        ) : null}
        {statements.keepPeriodsCurrent ? (
          <div className="banner banner-warn" role="alert" style={{ marginBottom: 12 }}>
            <span className="banner-body">{statements.keepPeriodsCurrent}</span>
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

        {/* #2349 — the on-chain switches never block a lender's direct
            accept, only the matcher and keepers, so the posture is
            DISCLOSED here — in every state — rather than disabling the form. */}
        <AutoMatchPostureBanner posture={autoRefinancePosture} />
        {quoteQuery.isError && !quoteReady ? (
          <div className="banner banner-warn" role="alert" style={{ marginTop: 12 }}>
            <span className="banner-body">{copy.refinance.permit.quoteUnavailable}</span>
          </div>
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
              !quoteReady ||
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
                checked={consent.given}
                onChange={(e) => consent.set(e.target.checked)}
                style={{ marginTop: 4 }}
              />
              <span>{copy.refinance.consentLabel}</span>
            </label>
            <ConsentWithdrawnNote consent={consent} />
            <ConfirmReceipt
              busy={busy}
              confirmLabel={copy.refinance.confirm}
              onBack={onCloseConfirm}
              onConfirm={() => void submit()}
              // graceReady here too: the bucket query can refresh to
              // undefined (chain hop) while this receipt is open.
              disabled={
                !walletReady ||
                !consent.given ||
                !graceReady ||
                !quoteReady ||
                flowDisabled('post-offer')
              }
              data={{
                youReceive: copy.refinance.receiptReceive,
                youLock: copy.refinance.receiptLock,
                youMayOwe: `${copy.refinance.receiptYouMayOwe(payoffStr)} ${copy.refinance.payoffNote} ${
                  payoffHeadroom > 0n
                    ? `${copy.refinance.permit.growthDisclosure(headroomStr)} `
                    : ''
                }${
                  // #3042 — a zero share needs no permit, so none is disclosed.
                  permitNeeded(payoffBound)
                    ? `${copy.refinance.permit.signDisclosure(boundStr)} ${copy.refinance.permit.permit2ApprovalNote} `
                    : ''
                }${copy.refinance.walletNote(topUpStr)}`,
                youCanLose: `${copy.refinance.noGuarantee} ${copy.refinance.shortIsSafe}`,
                fees: `${copy.fees.borrowerLIF(lifPct)} ${copy.refinance.feesTreasuryNote(formatBpsAsPercent(fees.treasuryFeeBps))}`,
                whenThisEnds: `${statements.whenEnds} ${copy.refinance.guardrailNote}`,
              }}
            >
              {statements.cadenceChange ? (
                <div className="banner banner-warn" role="alert" style={{ marginBottom: 12 }}>
                  <span className="banner-body">{statements.cadenceChange}</span>
                </div>
              ) : null}
              <p className="muted" style={{ marginBottom: 12 }}>
                {copy.refinance.permit.multiStepNote}
              </p>
            </ConfirmReceipt>
          </div>
        )}
      </div>

      {error ? (
        <div className="banner banner-danger" role="alert" style={{ marginTop: 12 }}>
          <span className="banner-body">{error}</span>
        </div>
      ) : null}
    </section>
  );
}
