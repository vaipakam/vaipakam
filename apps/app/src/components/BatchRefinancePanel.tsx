/**
 * Post a refinance request for every loan that came from one offer, on the
 * same terms (#126 slice 3). Rendered inside the borrower's offer card
 * (`BatchCloseOutCard`), so a group runs one batch at a time.
 *
 * One rate ceiling and one duration for the whole group. Every loan is
 * planned through the same live checks its own page's refinance form runs
 * (`refinancePlan.ts`): the request it would post, the guardrail write it
 * needs first, its payoff today, the spare balance an acceptance needs and
 * the approval bound at the request's last fillable moment. A loan with
 * anything else to disclose, or whose figures grew since the review, is
 * left out and named.
 *
 * One approval for the sum of the bounds, after a balance check against
 * the sum of the spare amounts; then each loan's calls go to the Diamond's
 * `multicall` as consecutive items, up to 15 loans per transaction, each
 * running as the borrower with `allowFailure`. The request is refused
 * without the guardrails it needs, so a failed guardrail write can never
 * leave a request posted on looser ones.
 *
 * #1558 — the approval is of Permit2, which moves nothing without a
 * signature. Once the requests are posted, the borrower signs one payoff
 * permit per posted request (exactly its bound, expiring with it), and one
 * more `multicall` attaches them all. A posted request whose permit was
 * not signed or did not attach is named, so its loan's page can sign it.
 * BRIDGE (#3074): on a Diamond deployed before #1558 the approval is of
 * the Diamond itself, no permit is signed, and the approval is set back
 * only when it is established that no request was posted.
 *
 * Which loans got a request, and which got a permit, is read from the
 * transactions' own logs (`batchRefinance.ts`).
 */
import { useState, type ReactNode } from 'react';
import { LoaderCircle } from 'lucide-react';
import { usePublicClient, useWalletClient } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import { copy } from '../content/copy';
import { useActiveChain } from '../chain/useActiveChain';
import { useDiamondWrite, useTermsBlockNonExitWrites } from '../contracts/diamond';
import { ensureAllowance, trackApproval, useTokenMeta } from '../contracts/erc20';
import {
  ensurePermit2Approval,
  permitNeeded,
  setPayoffPermitCall,
  signRefinancePayoffPermit,
  type SignedPayoffPermit,
} from '../contracts/refinancePayoffPermit';
import { assertErc20BalanceLive } from '../contracts/preflights';
import { captureTxError, isPositiveDecimal } from '../lib/errors';
import { flowDisabled } from '../lib/killSwitch';
import { formatBpsAsPercent, formatTokenAmountExact } from '../lib/format';
import { MAX_INTEREST_BPS, percentToBps } from '../lib/offerSchema';
import type { PositionLoan } from '../data/hooks';
import { useProtocolFees } from '../data/fees';
import { useAutoRefinancePosture } from '../data/protocol';
import {
  readApprovalsLeft,
  settleFailedSend,
  type Mined,
  type OfferGroup,
} from '../data/batchCloseOut';
import { MAX_MULTICALL_CALLS, chunkForMulticall, encodeBestEffort } from '../data/multicall';
import {
  planRefinanceForBatch,
  type RefinanceBatchPlan,
  type RefinanceCtx,
  type RefinanceTerms,
  type ReviewedFees,
} from '../data/refinancePlan';
import {
  chunkRefinanceLoans,
  noRequestPosted,
  permitsInLogs,
  readBackRequests,
  refinanceSendCalls,
  refinanceTotals,
  type RefinanceBatchOutcome,
} from '../data/batchRefinance';
import { rememberRefinanceOffer } from '../data/refinancePending';
import { useReviewConsent } from '../hooks/useReviewConsent';
import { AutoMatchPostureBanner } from './AutoMatchPostureBanner';
import { ConfirmReceipt } from './ConfirmReceipt';
import { ConsentWithdrawnNote } from './ConsentWithdrawnNote';

type ReadyPlan = Extract<RefinanceBatchPlan, { kind: 'ready' }>;

type Stage =
  | { kind: 'idle' }
  | { kind: 'planning' }
  | { kind: 'review'; terms: RefinanceTerms; fees: ReviewedFees; plans: RefinanceBatchPlan[] }
  | { kind: 'sending'; step: 'approving' | 'checking' | 'submitting' | 'signing' | 'attaching' }
  | { kind: 'done'; outcomes: RefinanceBatchOutcome[]; note: string | null };

/** What the consent covers: the terms, the fee config and every figure and
 *  statement the review shows, so any change to them clears the tick. */
function reviewFingerprint(stage: Stage): string {
  if (stage.kind !== 'review') return stage.kind;
  return JSON.stringify(
    {
      terms: stage.terms,
      fees: stage.fees,
      plans: stage.plans.map((p) =>
        p.kind === 'ready'
          ? [p.loanId, p.route, p.payoff, p.topUp, p.bound, p.headroom, p.notes]
          : [p.loanId, p.reason],
      ),
    },
    (_, v) => (typeof v === 'bigint' ? v.toString() : v),
  );
}

export function BatchRefinancePanel({
  group,
  onStart,
  onExit,
}: {
  group: OfferGroup<PositionLoan>;
  /** Called when planning starts, so the card holds the group. */
  onStart: () => void;
  /** Back to the card's own actions; the card releases the group. */
  onExit: () => void;
}) {
  const { address, walletChain, onSupportedChain } = useActiveChain();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });
  const queryClient = useQueryClient();
  const { write } = useDiamondWrite();
  const termsVerdict = useTermsBlockNonExitWrites();
  const fees = useProtocolFees();
  const { posture } = useAutoRefinancePosture();
  const meta = useTokenMeta(group.loans[0]?.lendingAsset);
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  // Seeded from the first loan, as the loan page seeds from the loan it
  // replaces: the loans from one offer start on its terms.
  const [rateInput, setRateInput] = useState(() =>
    String(Number(group.loans[0]?.interestRateBps ?? 0) / 100),
  );
  const [durationInput, setDurationInput] = useState(() =>
    String(group.loans[0]?.durationDays ?? ''),
  );
  const consent = useReviewConsent([reviewFingerprint(stage), address, walletChain?.chainId]);

  const rateBps = isPositiveDecimal(rateInput) ? percentToBps(rateInput) : null;
  const rateValid = rateBps !== null && rateBps > 0 && rateBps <= MAX_INTEREST_BPS;
  const durationDays = /^\d+$/.test(durationInput) ? parseInt(durationInput, 10) : null;
  const durationValid =
    durationDays !== null && durationDays >= 1 && durationDays <= fees.maxOfferDurationDays;
  const disabledBySwitch = flowDisabled('post-offer');

  const ctx: RefinanceCtx | null =
    address && walletChain && publicClient
      ? { publicClient, diamond: walletChain.diamondAddress, holder: address }
      : null;
  const ready = Boolean(ctx && walletClient && onSupportedChain && meta.data && fees.ready);
  const amount = (raw: bigint) =>
    meta.data ? `${formatTokenAmountExact(raw, meta.data.decimals)} ${meta.data.symbol}` : '';
  const byId = new Map(group.loans.map((l) => [l.loanId, l]));

  /** The Terms gate, said before any read: a request is not an exit, so
   *  the write would be refused at submission, after an approval the
   *  borrower could not use (#1961). */
  function termsBlocked(): string | null {
    const verdict = termsVerdict();
    if (verdict === 'ok') return null;
    return verdict === 'unknown' ? copy.errors.termsCheckUnavailable : copy.errors.termsNotAccepted;
  }

  async function plan() {
    if (!ctx || rateBps === null || !rateValid || durationDays === null || !durationValid) return;
    const blocked = disabledBySwitch ? copy.killSwitch.disabled : termsBlocked();
    if (blocked) {
      setError(blocked);
      return;
    }
    const terms: RefinanceTerms = { rateBps, durationDays };
    const reviewedFees: ReviewedFees = {
      treasuryFeeBps: fees.treasuryFeeBps,
      loanInitiationFeeBps: fees.loanInitiationFeeBps,
      maxOfferDurationDays: fees.maxOfferDurationDays,
    };
    onStart();
    setError(null);
    // A new review starts unconsented: the tick covers only the figures
    // this review is about to show.
    consent.clear();
    setStage({ kind: 'planning' });
    const plans = await Promise.all(
      group.loans.map((l) => planRefinanceForBatch(ctx, l, terms, reviewedFees)),
    );
    if (plans.some((p) => p.kind === 'refused' && p.feesMoved)) {
      // The cached fee config the review would quote is behind the chain.
      void queryClient.invalidateQueries({ queryKey: ['protocolFees'] });
    }
    setStage({ kind: 'review', terms, fees: reviewedFees, plans });
  }

  const exit = () => {
    setError(null);
    consent.clear();
    setStage({ kind: 'idle' });
    onExit();
  };

  async function confirm(terms: RefinanceTerms, reviewedFees: ReviewedFees, plans: RefinanceBatchPlan[]) {
    if (!ctx || !walletClient || !walletChain || !address || !consent.given) return;
    const blocked = flowDisabled('post-offer') ? copy.killSwitch.disabled : termsBlocked();
    if (blocked) {
      setError(blocked);
      return;
    }
    setError(null);
    const leftOut: RefinanceBatchOutcome[] = plans
      .filter((p) => p.kind === 'refused')
      .map((p) => ({ loanId: p.loanId, kind: 'left-out', reason: p.reason }));
    const reviewed = new Map(
      plans.filter((p): p is ReadyPlan => p.kind === 'ready').map((p) => [p.loanId, p]),
    );
    // The late re-check refuses a loan whose bound or spare amount grew,
    // so every loan sent needs at most what these totals checked and
    // approved.
    const totals = refinanceTotals([...reviewed.values()]);
    // One Diamond, one route: every reviewed plan read the same routing.
    const permitRoute = [...reviewed.values()].some((p) => p.route === 'permit');
    // BRIDGE (#3074): only a standing approval of the Diamond is tracked
    // and unwound; an approval of Permit2 moves nothing on its own.
    const approvals = permitRoute
      ? []
      : totals.map((t) => ({ token: t.token, tracker: trackApproval() }));
    // The late plan each loan was sent on: its permit is signed for that
    // plan's bound and deadline.
    const sentPlans = new Map<number, ReadyPlan>();
    const unwindClients = {
      publicClient: ctx.publicClient,
      walletClient,
      owner: address,
      spender: walletChain.diamondAddress,
    };
    const unwindAll = async (): Promise<boolean> =>
      (await Promise.all(approvals.map((a) => a.tracker.unwind(unwindClients)))).every(Boolean);
    const outcomes: RefinanceBatchOutcome[] = [];
    let sent = false;

    /**
     * #1558 — sign a payoff permit for each request this batch posted, then
     * attach them in as few transactions as the multicall allows. A request
     * whose permit was not signed (the wallet refused, or stopped) or did
     * not attach is turned into `postedNoPermit`, so the results name it
     * and its loan's page offers to sign. One whose attaching transaction
     * was sent but neither confirmed nor refused is `postedPermitPending`:
     * it may still attach, so the results say that is not known yet. Signing stops at the first
     * refusal: the wallet said no, and asking again for each remaining
     * request would not be a choice.
     */
    async function attachPermits(
      all: RefinanceBatchOutcome[],
      plansById: Map<number, ReadyPlan>,
    ): Promise<void> {
      if (!ctx || !walletClient || !walletChain || !address) return;
      // #3042 — a request whose wallet share is zero needs no permit (and
      // the contract refuses one for zero): it stays plainly `posted`.
      const needsPermit = (o: RefinanceBatchOutcome): boolean => {
        const p = plansById.get(o.loanId);
        return p === undefined || permitNeeded(p.bound);
      };
      const posted = all.filter(
        (o): o is Extract<RefinanceBatchOutcome, { kind: 'posted' }> =>
          o.kind === 'posted' && needsPermit(o),
      );
      if (posted.length === 0) return;
      setStage({ kind: 'sending', step: 'signing' });
      const signed: { offerId: bigint; permit: SignedPayoffPermit }[] = [];
      for (const o of posted) {
        const p = plansById.get(o.loanId);
        if (!p) continue;
        try {
          signed.push({
            offerId: BigInt(o.offerId),
            permit: await signRefinancePayoffPermit({
              walletClient,
              chainId: walletChain.chainId,
              diamond: walletChain.diamondAddress,
              owner: address,
              token: p.liveLoan.principalAsset,
              maxAmount: p.bound,
              deadline: p.permitDeadline,
              loanId: BigInt(p.loanId),
              offerId: BigInt(o.offerId),
            }),
          });
        } catch {
          break;
        }
      }
      const attached = new Set<string>();
      const unsure = new Set<string>();
      setStage({ kind: 'sending', step: 'attaching' });
      for (const chunk of chunkForMulticall(signed, MAX_MULTICALL_CALLS)) {
        let submitted: `0x${string}` | null = null;
        let mined: Mined;
        try {
          const { receipt } = await write(
            'multicall',
            [encodeBestEffort(chunk.map((c) => setPayoffPermitCall(c.offerId, c.permit)))],
            { onSubmitted: (hash) => (submitted = hash) },
          );
          mined = { block: receipt.blockNumber, logs: receipt.logs };
        } catch (err) {
          mined = await settleFailedSend(ctx.publicClient, submitted, err);
        }
        if ('block' in mined) {
          for (const id of permitsInLogs(mined.logs, walletChain.diamondAddress, address)) {
            attached.add(id);
          }
        } else if ('pending' in mined) {
          // Sent and neither confirmed nor refused: it may still attach
          // these permits, so "not attached" is not established for them.
          for (const c of chunk) unsure.add(c.offerId.toString());
        }
      }
      for (const [i, o] of all.entries()) {
        if (o.kind !== 'posted' || !needsPermit(o) || attached.has(o.offerId)) continue;
        all[i] = unsure.has(o.offerId)
          ? { loanId: o.loanId, kind: 'postedPermitPending', offerId: o.offerId }
          : { loanId: o.loanId, kind: 'postedNoPermit', offerId: o.offerId };
      }
    }
    try {
      // The wallet must be able to fund every acceptance's spare amount,
      // and one approval covers every request's largest payoff.
      setStage({ kind: 'sending', step: 'approving' });
      for (const [i, t] of totals.entries()) {
        await assertErc20BalanceLive({
          publicClient: ctx.publicClient,
          token: t.token,
          owner: address,
          amount: t.topUp,
          symbol: meta.data?.symbol,
        });
        if (permitRoute) {
          await ensurePermit2Approval({
            publicClient: ctx.publicClient,
            walletClient,
            owner: address,
            token: t.token,
            maxAmount: t.bound,
          });
        } else {
          await ensureAllowance({
            publicClient: ctx.publicClient,
            walletClient,
            token: t.token,
            owner: address,
            spender: walletChain.diamondAddress,
            amount: t.bound,
            ...approvals[i].tracker.hooks(t.token),
          });
        }
      }
      const chunks = chunkRefinanceLoans([...reviewed.keys()]);
      // Kept from the SEND, not from its loans' outcomes.
      let sendPending = false;
      let lastBatchBlock = 0n;
      for (const [index, chunk] of chunks.entries()) {
        // A transaction still unconfirmed may yet post its requests, so
        // nothing more is sent behind it.
        if (sendPending) {
          for (const id of chunks.slice(index).flat()) {
            leftOut.push({ loanId: id, kind: 'left-out', reason: copy.batchRefinance.notSentPending });
          }
          break;
        }
        // LATE re-check, immediately before EACH send, in full: the wallet
        // may have waited on the approval or the previous send while a
        // sale was accepted, a request or offset posted elsewhere, the
        // position NFT moved, or the loan slid past its due date.
        setStage({ kind: 'sending', step: 'checking' });
        const late = await Promise.all(
          chunk.map((id) =>
            planRefinanceForBatch(ctx, byId.get(id)!, terms, reviewedFees, reviewed.get(id)),
          ),
        );
        for (const p of late) {
          if (p.kind === 'refused') leftOut.push({ loanId: p.loanId, kind: 'left-out', reason: p.reason });
        }
        const go = late.filter((p): p is ReadyPlan => p.kind === 'ready');
        if (go.length === 0) continue;
        for (const p of go) sentPlans.set(p.loanId, p);
        setStage({ kind: 'sending', step: 'submitting' });
        let submitted: `0x${string}` | null = null;
        let mined: Mined;
        sent = true;
        try {
          const { receipt } = await write('multicall', [encodeBestEffort(refinanceSendCalls(go))], {
            onSubmitted: (hash) => (submitted = hash),
          });
          mined = { block: receipt.blockNumber, logs: receipt.logs };
        } catch (err) {
          mined = await settleFailedSend(ctx.publicClient, submitted, err);
        }
        sendPending = 'pending' in mined;
        if ('block' in mined && mined.block > lastBatchBlock) lastBatchBlock = mined.block;
        const read = await readBackRequests(ctx, go, mined);
        for (const o of read) {
          // The loan page names its request from this before discovery's
          // next poll.
          if (o.kind === 'posted') rememberRefinanceOffer(walletChain.chainId, o.loanId, o.offerId);
        }
        outcomes.push(...read);
      }
      if (permitRoute) {
        await attachPermits(outcomes, sentPlans);
      }
      // Set the approval back only when it is ESTABLISHED that no request
      // was posted: a request a lender may accept needs it. The figure
      // stated is read from the chain afterwards, never assumed.
      let note: string | null = null;
      if (approvals.length > 0) {
        const cleanupFailed = noRequestPosted(outcomes) && !(await unwindAll());
        const notBefore = approvals.reduce((max, a) => {
          const b = a.tracker.lastMinedBlock();
          return b !== null && b > max ? b : max;
        }, lastBatchBlock);
        const left = await readApprovalsLeft(ctx, totals.map((t) => t.token), notBefore);
        const leftText =
          left === null
            ? copy.batchClose.approvalLeftUnread
            : copy.batchRefinance.approvalLeft(left.map(amount).join(', '));
        note = cleanupFailed ? `${copy.errors.approvalCleanupFailed} ${leftText}` : leftText;
      }
      setStage({ kind: 'done', outcomes: [...outcomes, ...leftOut], note });
    } catch (err) {
      // Only the balance check and the approval run outside a per-send
      // catch, and both come before any send.
      const message = captureTxError(err);
      if (!sent) {
        const unwound = await unwindAll();
        setError(unwound ? message : `${message} ${copy.errors.approvalCleanupFailed}`);
        setStage({ kind: 'review', terms, fees: reviewedFees, plans });
      } else {
        setError(message);
        setStage({ kind: 'done', outcomes: [...outcomes, ...leftOut], note: null });
      }
    } finally {
      for (const key of ['refinancePending', 'refinanceDiscovery', 'myOffers', 'loanLive']) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
    }
  }

  const busy = stage.kind === 'planning' || stage.kind === 'sending';

  return (
    <>
      <p className="muted" style={{ marginTop: 0 }}>
        {copy.batchRefinance.lede}
      </p>
      {/* #544 — a request is not a match; the loan page shows this in
          every state, and so does the batch. */}
      <div className="banner banner-info" style={{ marginBottom: 12 }}>
        <span className="banner-body">{copy.refinance.noGuarantee}</span>
      </div>
      <AutoMatchPostureBanner posture={posture} />
      {disabledBySwitch ? (
        <div className="banner banner-warn" role="alert">
          <span className="banner-body">{copy.killSwitch.disabled}</span>
        </div>
      ) : null}

      {stage.kind === 'idle' ? (
        <>
          <div className="cluster">
            <label className="field" style={{ flex: 1 }}>
              <span className="field-label">{copy.refinance.rateLabel}</span>
              <input
                className="input"
                inputMode="decimal"
                value={rateInput}
                onChange={(e) => setRateInput(e.target.value.trim())}
                aria-label={copy.refinance.rateLabel}
              />
            </label>
            <label className="field" style={{ flex: 1 }}>
              <span className="field-label">{copy.refinance.durationLabel}</span>
              <input
                className="input"
                inputMode="numeric"
                value={durationInput}
                onChange={(e) => setDurationInput(e.target.value.trim())}
                aria-label={copy.refinance.durationLabel}
              />
            </label>
          </div>
          {!durationValid && durationInput !== '' ? (
            <p className="field-hint" style={{ color: 'var(--danger)', marginTop: 8 }}>
              {copy.refinance.durationRange(fees.maxOfferDurationDays)}
            </p>
          ) : null}
          <div className="stack" style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!ready || !rateValid || !durationValid || disabledBySwitch}
              onClick={() => void plan()}
            >
              {copy.batchRefinance.review}
            </button>
            <button type="button" className="btn" onClick={exit}>
              {copy.batchRefinance.cancel}
            </button>
          </div>
        </>
      ) : null}

      {busy ? (
        <p className="muted">
          <LoaderCircle className="spin" aria-hidden size={16} />{' '}
          {stage.kind === 'planning'
            ? copy.batchRefinance.checking
            : copy.batchRefinance.phase[stage.step]}
        </p>
      ) : null}

      {stage.kind === 'review' ? (
        <RefinanceReview
          terms={stage.terms}
          plans={stage.plans}
          fees={stage.fees}
          amount={amount}
          consentGiven={consent.given}
          onConsent={consent.set}
          consentNote={<ConsentWithdrawnNote consent={consent} />}
          confirmDisabled={!ready || !consent.given || disabledBySwitch}
          onConfirm={() => void confirm(stage.terms, stage.fees, stage.plans)}
          onCancel={exit}
        />
      ) : null}

      {stage.kind === 'done' ? (
        <>
          <ul className="row-list" style={{ listStyle: 'none', padding: 0 }}>
            {stage.outcomes.map((o) => (
              <li key={o.loanId}>{outcomeText(o)}</li>
            ))}
          </ul>
          {stage.note ? <p className="muted">{stage.note}</p> : null}
          <button type="button" className="btn" onClick={exit}>
            {copy.batchRefinance.dismiss}
          </button>
        </>
      ) : null}

      {error ? (
        <div className="banner banner-danger" role="alert">
          <span className="banner-body">{error}</span>
        </div>
      ) : null}
    </>
  );
}

function RefinanceReview({
  terms,
  plans,
  fees,
  amount,
  consentGiven,
  onConsent,
  consentNote,
  confirmDisabled,
  onConfirm,
  onCancel,
}: {
  terms: RefinanceTerms;
  plans: RefinanceBatchPlan[];
  fees: ReviewedFees;
  amount: (raw: bigint) => string;
  consentGiven: boolean;
  onConsent: (checked: boolean) => void;
  consentNote: ReactNode;
  confirmDisabled: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ready = plans.filter((p): p is ReadyPlan => p.kind === 'ready');
  const totals = refinanceTotals(ready);
  const permitRoute = ready.some((p) => p.route === 'permit');
  return (
    <>
      <h3 style={{ marginBottom: 8 }}>{copy.batchRefinance.reviewTitle}</h3>
      {/* The inputs are gone once the review opens, so the terms being
          signed for are stated here. */}
      <p style={{ marginBottom: 8 }}>
        {copy.batchRefinance.terms(
          String(terms.durationDays),
          formatBpsAsPercent(terms.rateBps),
        )}
      </p>
      <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 12px' }}>
        {plans.map((p) => (
          <li key={p.loanId} style={{ marginBottom: 6 }}>
            {p.kind === 'ready' ? (
              <>
                {copy.batchRefinance.loanPayoff(String(p.loanId), amount(p.payoff))}
                <ul className="muted" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                  {p.headroom > 0n ? (
                    <li>{copy.batchRefinance.loanGrowth(amount(p.headroom))}</li>
                  ) : null}
                  <li>{copy.batchRefinance.loanTopUp(amount(p.topUp))}</li>
                  {/* What the loan page says about this loan before a request. */}
                  {p.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              </>
            ) : (
              copy.batchRefinance.leftOut(String(p.loanId), p.reason)
            )}
          </li>
        ))}
      </ul>
      {ready.length === 0 ? (
        <>
          <p className="muted">{copy.batchRefinance.noneReady}</p>
          <button type="button" className="btn" onClick={onCancel}>
            {copy.batchRefinance.cancel}
          </button>
        </>
      ) : (
        <>
          {totals.map((t) => (
            <p key={t.token} style={{ marginBottom: 8 }}>
              {copy.batchRefinance.totals(amount(t.topUp))}{' '}
              {permitRoute
                ? copy.batchRefinance.permit.total(amount(t.bound))
                : copy.batchRefinance.approval(amount(t.bound))}
            </p>
          ))}
          <label className="cluster" style={{ marginBottom: 12, alignItems: 'flex-start' }}>
            <input
              type="checkbox"
              checked={consentGiven}
              onChange={(e) => onConsent(e.target.checked)}
              style={{ marginTop: 4 }}
            />
            <span>{copy.batchRefinance.consentLabel}</span>
          </label>
          {consentNote}
          {/* The same six-row review every other write shows, worded for
              several requests. */}
          <ConfirmReceipt
            busy={false}
            confirmLabel={copy.batchRefinance.confirm}
            onBack={onCancel}
            onConfirm={onConfirm}
            disabled={confirmDisabled}
            data={{
              youReceive: copy.batchRefinance.receiveEach,
              youLock: copy.refinance.receiptLock,
              youMayOwe: permitRoute
                ? copy.batchRefinance.permit.youMayOwe
                : copy.batchRefinance.youMayOwe,
              youCanLose: `${copy.refinance.noGuarantee} ${copy.refinance.shortIsSafe}`,
              fees: `${copy.fees.borrowerLIF(formatBpsAsPercent(fees.loanInitiationFeeBps))} ${copy.refinance.feesTreasuryNote(formatBpsAsPercent(fees.treasuryFeeBps))}`,
              whenThisEnds: `${copy.batchRefinance.endsEach} ${copy.refinance.guardrailNote}`,
            }}
          />
        </>
      )}
    </>
  );
}

function outcomeText(o: RefinanceBatchOutcome): string {
  const id = String(o.loanId);
  switch (o.kind) {
    case 'posted':
      return copy.batchRefinance.posted(id, o.offerId);
    case 'postedNoPermit':
      return copy.batchRefinance.permit.postedNoPermit(id, o.offerId);
    case 'postedPermitPending':
      return copy.batchRefinance.permit.postedPermitPending(id, o.offerId);
    case 'changed':
      return copy.batchRefinance.changedOtherwise(id);
    case 'open':
      return copy.batchRefinance.notPosted(id, o.reason);
    case 'left-out':
      return copy.batchRefinance.leftOut(id, o.reason);
    case 'unknown':
      return copy.batchRefinance.unknown(id);
    case 'pending':
      return copy.batchRefinance.pending(id);
  }
}
