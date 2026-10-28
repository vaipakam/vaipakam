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
 * If the user abandons the sequence after step 2, the allowance is
 * best-effort RESTORED to whatever it was before — a payoff-sized
 * authorization must not linger behind a pristine form with nothing to
 * cancel, and a pre-existing grant another arrangement depends on must
 * not be zeroed either.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { usePublicClient, useWalletClient } from 'wagmi';
import { parseEventLogs } from 'viem';
import { copy } from '../content/copy';
import { isPositiveDecimal, captureTxError } from '../lib/errors';
import { flowDisabled } from '../lib/killSwitch';
import { useActiveChain } from '../chain/useActiveChain';
import { DIAMOND_ABI_VIEM, useDiamondWrite, useTermsBlockNonExitWrites } from '../contracts/diamond';
import { ensureAllowance, restoreAllowance } from '../contracts/erc20';
import { TxNotSettledError } from '../contracts/ownReceipt';
import { assertErc20BalanceLive } from '../contracts/preflights';
import {
  loanEndTimeOf,
  refinanceApprovalOf,
  refinancePayoffOf,
  type LoanLive,
} from '../contracts/loanLive';
import { useProtocolFees } from '../data/fees';
import { REQUEST_WINDOW_DAYS, checkRefinanceRequest } from '../data/refinancePlan';
import { useAutoRefinancePosture } from '../data/protocol';
import { AutoMatchPostureBanner } from './AutoMatchPostureBanner';
import type { IndexedLoan } from '../data/indexer';
import { MAX_INTEREST_BPS, percentToBps } from '../lib/offerSchema';
import {
  formatBpsAsPercent,
  formatDate,
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
  const [done, setDone] = useState<string | null>(null);
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
  const graceEndTs = loanEndTimeOf(live, chainNow) + graceSec;
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
  const payoffStr = `${formatTokenAmountExact(payoff, dec)} ${sym}`;
  const topUpStr = `${formatTokenAmountExact(walletTopUp, dec)} ${sym}`;
  const headroomStr = `${formatTokenAmountExact(payoffHeadroom, dec)} ${sym}`;

  // Consent covers exactly what was reviewed (#1696): the terms the user
  // set, and the figures the live-loan prop, the fee config and the grace
  // bucket refresh in the background, so a payoff or fee quote can change
  // inside an open review. Keyed on the values, cleared in the same render.
  const consent = useReviewConsent([
    row.loanId,
    rateBps,
    durationDays,
    payoff,
    walletTopUp,
    payoffHeadroom,
    fees.loanInitiationFeeBps,
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
  const pastGrace = chainNow > loanEndTimeOf(live, chainNow) + graceSec;

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
    // The allowance as it stood BEFORE this attempt, so an abandoned
    // step 3 can put it back (see header). The prior VALUE, not a
    // boolean: ensureAllowance also raises a non-zero-but-insufficient
    // allowance, and zeroing that would destroy a grant another live
    // arrangement depends on (#1529 review).
    let priorAllowance: bigint | null = null;
    // The value THIS attempt last put on-chain — null while it has
    // written nothing. Stamped per mined approve rather than from
    // ensureAllowance's return value, so the zero-reset counts even when
    // the approve after it is rejected. The unwind acts only if the
    // allowance still reads exactly this (#1529 review).
    let wroteAllowance: bigint | null = null;
    // Hash of that write, so the unwind can settle a still-pending
    // approve instead of reading it as somebody else's change.
    let wroteAllowanceTx: `0x${string}` | null = null;
    // The last value the approve helper CONFIRMED. Needed when a later
    // approve's revert is only discovered by the unwind, after the helper
    // has thrown on a timeout and can no longer correct its own report.
    let confirmedAllowance: bigint | null = null;
    // Hash of the createOffer transaction once submitted. The unwind
    // needs it because creating the request does NOT consume the payoff
    // approval — the later acceptance does. So unlike the handover flow,
    // where a landed write eats the allowance and the restore no-ops by
    // itself, here a lost receipt on a transaction that actually mined
    // would strip the approval off a LIVE refinance offer, leaving one
    // whose acceptance cannot collect the payoff (#1529 review round 8).
    let createOfferTx: `0x${string}` | null = null;
    let approvalToken: `0x${string}` | null = null;
    try {
      // The live checks and the request they produce, shared with the
      // "Refinance all" batch on Positions (#126 slice 3): sanctions, the
      // borrower position still held, both assets unpaused, the loan
      // Active and still in or before its grace window, the ORIGINAL
      // borrower (see header), the reviewed fee config, the guardrails the
      // request needs, and the payoff and approval at the request's last
      // fillable moment. Read failures throw.
      const plan = await checkRefinanceRequest(
        { publicClient, diamond: walletChain.diamondAddress, holder: address },
        row,
        { rateBps, durationDays },
        fees,
      );
      if (plan.kind === 'refused') {
        if (plan.feesMoved) {
          // The receipt quoted the CACHED fee config — a governance retune
          // inside its window forces a re-review.
          void queryClient.invalidateQueries({ queryKey: ['protocolFees'] });
          throw new Error(plan.reason);
        }
        setError(plan.reason);
        return;
      }
      const { liveLoan } = plan;
      // The receipt disclosed the approval bound from the RENDER-time
      // chain clock — a backgrounded tab freezes it, and the plan is
      // judged at the live block. If the bound GREW (the loan slid toward
      // or past maturity while the receipt sat open), force a re-review
      // instead of signing headroom the reviewed figures never showed
      // (Codex #1256 r3). Shrinkage (a partial settled) is fine — the
      // pull only gets smaller. Checked before any write.
      if (plan.approval > approvalBound) {
        void queryClient.invalidateQueries({ queryKey: ['loanLive'] });
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
        amount: plan.topUp,
        symbol: sym,
      });
      // The standing allowance is what an abandoned step 3 restores. Any
      // pre-existing grant belongs to some other live arrangement (a
      // prior request, a sale listing, a user-managed approval), so the
      // unwind must put that figure back rather than zero it:
      // ensureAllowance raises a non-zero but insufficient allowance
      // too, and treating that as ours to erase would break the flow
      // relying on it. The figure comes from ensureAllowance's OWN read
      // — sampling it separately here would be a second moment, and
      // anything moving the allowance in between would leave this stale
      // so the unwind restored a value that was never replaced (#1529
      // review).
      approvalToken = liveLoan.principalAsset;
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
      await ensureAllowance({
        publicClient,
        walletClient,
        token: liveLoan.principalAsset,
        owner: address,
        spender: walletChain.diamondAddress,
        amount: plan.approval,
        onObserved: (value) => {
          priorAllowance = value;
        },
        onWrote: (value, hash) => {
          wroteAllowance = value;
          wroteAllowanceTx = hash;
        },
        onConfirmed: (value) => {
          confirmedAllowance = value;
        },
      });
      // The request itself, with its own hard expiry — what makes the
      // reviewed lifetime true even when looser caps pre-exist, and the
      // bound the approval above was computed against.
      const payload = plan.payload;
      // LATE re-gate (Codex #1511 r10 P1) — see the entry gate note.
      if (preSubmitBlock) {
        const blockedLate = await preSubmitBlock();
        if (blockedLate) {
          setError(blockedLate);
          // This return skips the catch, but the payoff approval may
          // already have MINED above — unwind it the same best-effort
          // way (Codex #1511 r11): a blocked submit must not leave a
          // payoff-sized authorization behind a pristine form.
          await unwindApproval();
          return;
        }
      }
      const { receipt } = await write('createOffer', [payload], {
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
      setDone(copy.refinance.done);
      consent.clear();
      onCloseConfirm();
      void queryClient.invalidateQueries({ queryKey: ['myOffers'] });
    } catch (err) {
      setError(captureTxError(err));
      // Unwind the payoff approval so a rejected step 3 leaves no
      // payoff-sized authorization behind a pristine form with nothing to
      // cancel. Best-effort: a second rejection just leaves the wallet's
      // approvals view as the remedy (the error banner already shows the
      // failure).
      //
      // But ONLY once it is established that no offer exists. `write`
      // throws for three different reasons and they are not equivalent:
      // never submitted (safe to unwind), submitted and reverted (safe),
      // or submitted with the receipt lost — in which case the offer may
      // be live on chain and its approval is load-bearing. Failing to
      // unwind leaves a stale approval the user can revoke from the
      // approvals view; unwinding wrongly breaks a commitment a
      // counterparty is entitled to act on. Those are not symmetric, so
      // an unknown outcome keeps the approval.
      const offerMayExist = await (async () => {
        if (createOfferTx === null) return false; // never submitted
        // A settlement failure is POSITIVE evidence, and it is the whole
        // reason the error carries a reason at all. Cancelled or
        // replaced: our call never executed, so no offer exists.
        // Reverted: it executed and produced nothing. All three are safe
        // to unwind, and none of them can be recovered from a receipt
        // lookup — a cancelled transaction's own hash has no receipt, so
        // asking for one throws and reads as "cannot tell", which kept
        // the approval standing for a confirmed cancel (#1529 review
        // round 12).
        if (err instanceof TxNotSettledError) return false;
        try {
          const r = await publicClient.getTransactionReceipt({ hash: createOfferTx });
          return r.status === 'success';
        } catch {
          return true; // cannot tell — assume it landed and keep the approval
        }
      })();
      if (offerMayExist) {
        setError(copy.refinance.postedButUnconfirmed);
      } else {
        await unwindApproval();
      }
    } finally {
      setBusy(false);
    }

    // ONE unwind, shared by every abandoning exit — the late-gate return
    // above and the catch below it. They were duplicated inline, and the
    // duplication did exactly what duplication does: round 13 taught the
    // catch to surface a failed cleanup and the late-gate copy kept
    // swallowing it, so a blocked submit could erase a standing grant and
    // say nothing (#1529 review round 14). Mirrors the shape
    // `ObligationTransferFlow` already uses, where a single helper is why
    // that fix covered both of its paths at once.
    //
    // Best-effort by design: the cleanup must not REPLACE the reason the
    // flow stopped — that is what the user was trying to do — but a reset
    // to zero whose put-back then fails leaves their prior grant erased,
    // which is state they have to act on. So the failure is APPENDED.
    async function unwindApproval() {
      if (priorAllowance === null || !approvalToken) return;
      if (!publicClient || !walletClient || !address || !walletChain) return;
      const previous = priorAllowance;
      const wrote = wroteAllowance;
      const wroteTx = wroteAllowanceTx;
      const confirmedVal = confirmedAllowance;
      // Cleared before the await so a second exit path cannot unwind twice.
      priorAllowance = null;
      wroteAllowance = null;
      wroteAllowanceTx = null;
      try {
        await restoreAllowance({
          publicClient,
          walletClient,
          token: approvalToken,
          owner: address,
          spender: walletChain.diamondAddress,
          previous,
          wrote,
          wroteTxHash: wroteTx,
          confirmed: confirmedVal,
        });
      } catch {
        setError((prior) =>
          prior
            ? `${prior} ${copy.errors.approvalCleanupFailed}`
            : copy.errors.approvalCleanupFailed,
        );
      }
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

        {/* #2349 — the on-chain switches never block a lender's direct
            accept, only the matcher and keepers, so the posture is
            DISCLOSED here — in every state — rather than disabling the form. */}
        <AutoMatchPostureBanner posture={autoRefinancePosture} />
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
                youCanLose: `${copy.refinance.noGuarantee} ${copy.refinance.shortIsSafe}`,
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
