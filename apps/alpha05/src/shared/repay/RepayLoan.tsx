import { useEffect, useRef, useState } from 'react';
import type { Abi, Log } from 'viem';
import { useConfig } from 'wagmi';
import { writeContract } from 'wagmi/actions';
import { RepayFacetABI } from '@vaipakam/contracts/abis';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { useCopy } from '../copy/useCopy';
import { refusalFromError, StatedRefusal } from '../eligibility/refusal';
import { WhyLink } from '../help/WhyLink';
import { moved } from '../offers/acceptOutcome';
import { exactTokenAmount, tokenAmount, type TokenMetaMap } from '../reads/tokens';
import type { AnchoredReader } from '../tx/anchored';
import { allowanceSteps } from '../tx/approval';
import { allowanceMoved, approvalFlow } from '../tx/approvalFlow';
import { cleanUpLeg } from '../tx/cleanUp';
import type { LegOutcome } from '../tx/outcome';
import { askThrough } from '../tx/simulate';
import { useStoredValue, useTxNote } from '../tx/txStore';
import { useMounted, useReviewRefresh } from '../tx/useReviewRefresh';
import { useTrackedTx } from '../tx/useTrackedTx';
import { ActionFlow, reviewIdentity, type Recheck } from '../ui/ActionFlow';
import { Notice } from '../ui/Notice';
import { GraceClock } from './GraceClock';
import { shortAddress } from '../ui/format';
import { allowanceFigure } from './approvalCap';
import { repaidStatus } from './repaidLog';
import { repayReceipt } from './repayReceipt';
import { changedBetween, promptCount, readRepayReview, reviewBlockers, type RepayReview } from './repayReview';

type Hex = `0x${string}`;

const REPAY_ABI = RepayFacetABI as Abi;

/** `LibVaipakam.LoanStatus.Repaid`. */
const STATUS_REPAID = 1;

/** The store key a loan's full repayment keeps its state under: one per
 *  loan, so a repayment in flight on one loan never shows on another, and
 *  a navigation that unmounts the panel never drops its review or hash. */
export function repayKey(loanId: bigint): string {
  return `position.repay.${loanId.toString()}`;
}

interface RepayLoanProps {
  loanId: bigint;
  chain: SupportedChain;
  own: OwnStateClient;
  meta: TokenMetaMap | null;
  onClose: () => void;
}

/**
 * LN-21 — repay a loan in full, by anyone except the lender. The review is
 * the protocol's own settlement figure now and at a moment a short while
 * ahead (the figure grows by the second); the allowance is set to exactly
 * the later figure, lowered when a larger approval stands, since the
 * repayment takes no maximum of its own; the repayment is sent
 * only after a dry run passes, and what the repayment does not use of the
 * approval is put back afterwards (best effort, stated either way). The
 * outcome is measured from the transaction's own logs: the status its
 * repayment left the loan in, and what left the wallet.
 */
export function RepayLoan({ loanId, chain, own, meta, onClose }: RepayLoanProps) {
  const copy = useCopy();
  const { text, format } = copy;
  const config = useConfig();
  const diamond = chain.diamondAddress;
  const account = own.account;
  const identity = reviewIdentity(own);
  const flowKey = repayKey(loanId);
  const [review, setReview] = useStoredValue<RepayReview>(`${flowKey}:review`);
  const [loadError, setLoadError] = useState<string | null>(null);
  const setStep = useTxNote(flowKey);
  /** The approval this flow made and has not yet seen used or put back. A
   *  ref, because the tracker runs the clean-up from the closure it froze
   *  at submission. */
  const approvalLeft = useRef<{ token: Hex; prior: bigint; amount: bigint; since: bigint | null } | null>(null);
  /** After a repayment that took effect: what of the approval it should
   *  have left (the approval less what it took), to put back. */
  const leftover = useRef<{ token: Hex; prior: bigint; expect: bigint; since: bigint } | null>(null);

  const exact = (asset: Hex, v: bigint) => exactTokenAmount(v, asset, meta, format);
  const { readAllowance, allowanceIo, approveExactly, putBack } = approvalFlow({ own, config, chainId: chain.chainId, diamond, copy, exactAmount: exact, setStep });

  const tx = useTrackedTx({
    key: flowKey,
    chainId: chain.chainId,
    account,
    sources: own.sources,
    send: async () => {
      if (!review) throw new Error('no repayment under review');
      const r = review;
      const asset = r.loan.principalAsset;
      const amount = r.payoff.atBy;
      const total = promptCount(r);
      let n = 0;
      const say = (what: string) => setStep(format('accept.stepOf', { n: String(++n), total: String(total), what }));
      approvalLeft.current = null;
      leftover.current = null;

      // The allowance is read again now: the value a stop puts back is the
      // one the wallet holds right before this flow's approval.
      const io = allowanceIo(asset, (v, i, of) => say(of === 2 && i === 0 ? text('approval.stepZero') : format('repay.stepApprove', { amount: exact(asset, v) })));
      const prior = await readAllowance(asset);
      // Exactly the reviewed maximum, lowered too: `repayLoan` has no
      // maximum or deadline of its own, so the allowance is the only cap on
      // what a late confirmation can take.
      // The prior allowance is what a stop puts back and what the review
      // stated: a change since the review reopens it.
      if (prior !== r.allowance) throw allowanceMoved(copy);
      const steps = await allowanceSteps(io, prior, amount);
      if (steps.length !== r.approvalSteps) throw allowanceMoved(copy);
      const approved = steps.length > 0;
      let since: bigint | null = null;
      if (approved) {
        since = await approveExactly(io, asset, amount, prior);
        approvalLeft.current = { token: asset, prior, amount, since };
      }

      const stop = async (reason: string): Promise<never> => {
        if (!approved) throw new StatedRefusal({ code: 'RepayStopped', reason, reopensAt: null, remedy: null });
        approvalLeft.current = null;
        const after = await putBack(asset, prior, amount, since);
        throw new StatedRefusal({ code: 'RepayStopped', reason: `${reason} ${after.sentence}`, reopensAt: null, remedy: null });
      };

      // The dry run: the protocol's own verdict on this repayment, now.
      const dry = await askThrough(own, (c) => c.simulateContract({ address: diamond, abi: REPAY_ABI, functionName: 'repayLoan', args: [loanId], account }));
      if (dry.kind === 'reverted') return stop(format('repay.dryRunRefused', { reason: refusalFromError(dry.error).reason }));
      if (dry.kind === 'unreadable') return stop(format('flow.unreadable', { reason: dry.reason }));

      say(text('repay.stepSend'));
      try {
        return await writeContract(config, { address: diamond, abi: REPAY_ABI, functionName: 'repayLoan', args: [loanId], chainId: chain.chainId, account });
      } catch (e) {
        return stop(format('repay.stoppedAfterApproval', { reason: refusalFromError(e).reason }));
      }
    },
    // A sent repayment that did not take effect used none of the approval.
    unwind: async () => {
      const left = approvalLeft.current;
      approvalLeft.current = null;
      if (!left) return null;
      const after = await putBack(left.token, left.prior, left.amount, left.since);
      return cleanUpLeg(after, format('approval.legBack', { amount: allowanceFigure(left.prior, left.token, meta, copy) }));
    },
    measure: async (receipt, at) => (review ? measure(review, receipt.logs, at) : []),
    // After a repayment that took effect: the approval it did not use is
    // put back, judged against what it should have left.
    release: async () => {
      const left = leftover.current;
      leftover.current = null;
      if (!left) return null;
      const after = await putBack(left.token, left.prior, left.expect, left.since);
      return cleanUpLeg(after, format('repay.legPutBack', { amount: allowanceFigure(left.prior, left.token, meta, copy) }));
    },
  });

  /** What the repayment left the loan as (its own log), and what left the wallet. */
  const measure = async (r: RepayReview, logs: readonly Log[], at: AnchoredReader): Promise<LegOutcome[]> => {
    const asset = r.loan.principalAsset;
    const legs: LegOutcome[] = [];
    const repaidLabel = format('repay.legRepaid', { id: loanId.toString() });
    // The repayment's own log, not the status at the block: a claim by both
    // sides later in the same block settles the loan, after it was repaid.
    const status = repaidStatus(logs, diamond, loanId);
    legs.push(status === STATUS_REPAID ? { status: 'done', label: repaidLabel } : { status: 'not-done', label: repaidLabel, reason: text('repay.notRepaid') });
    // What left the wallet: the protocol takes the figure as of this block,
    // which lies between the two figures the review stated.
    const paid = moved(logs, asset, account, null);
    const left = approvalLeft.current;
    approvalLeft.current = null;
    if (left && paid <= left.amount) leftover.current = { token: left.token, prior: left.prior, expect: left.amount - paid, since: at.blockNumber };
    const paidLabel = format('repay.legPaid', { amount: tokenAmount(paid, asset, meta, format) });
    if (paid >= r.payoff.now && paid <= r.payoff.atBy) legs.push({ status: 'done', label: paidLabel });
    else
      legs.push({
        status: paid === 0n ? 'not-done' : 'unknown',
        label: paidLabel,
        reason: format('repay.paidOther', { amount: exact(asset, paid), now: exact(asset, r.payoff.now), by: exact(asset, r.payoff.atBy) }),
      });
    return legs;
  };

  const mounted = useMounted();
  const load = async () => {
    try {
      const next = await readRepayReview(own, diamond, loanId, identity, copy);
      if (!mounted.current) return;
      setLoadError(null);
      setReview(next);
    } catch (e) {
      setLoadError(refusalFromError(e).reason);
    }
  };

  const keepOf = (r: RepayReview) => ({ by: r.payoff.by, capped: r.capped });

  // RB-RAILS: read again each block while the review is on screen; the
  // payoff now updates in place, and only a change the review states
  // (changedBetween) reopens it.
  const onReview = tx.phase.kind === 'review' && review !== null && review.loanId === loanId;
  useReviewRefresh<RepayReview>({
    chainId: chain.chainId,
    active: onReview,
    review,
    read: (before) => readRepayReview(own, diamond, before.loanId, before.identity, copy, keepOf(before)),
    sameSubject: (a, b) => a.loanId === b.loanId,
    changed: (before, next) => changedBetween(before, next, copy) !== null,
    setReview,
    // No consent to clear: the review itself shows what changed.
    onChanged: () => undefined,
  });

  const reviewOpened = useRef(false);
  useEffect(() => {
    const open = tx.phase.kind === 'idle' || tx.phase.kind === 'review';
    if (!open) return;
    if (tx.phase.kind === 'idle' && !reviewOpened.current) {
      reviewOpened.current = true;
      tx.review();
    }
    if (review === null || review.loanId !== loanId || review.identity !== identity) {
      setReview(null);
      let live = true;
      readRepayReview(own, diamond, loanId, identity, copy).then(
        (next) => {
          if (!live) return;
          setLoadError(null);
          setReview(next);
        },
        (e: unknown) => {
          if (live) setLoadError(refusalFromError(e).reason);
        },
      );
      return () => {
        live = false;
      };
    }
    // Opened once per loan; the tracker and the stored review carry the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loanId]);

  const shortText = (asset: Hex) => (short: bigint) => format('repay.short', { amount: tokenAmount(short, asset, meta, format) });

  const recheck = async (current: () => boolean): Promise<Recheck> => {
    if (!review) return { kind: 'unreadable', reason: text('flow.reading') };
    let next: RepayReview;
    try {
      next = await readRepayReview(own, diamond, loanId, review.identity, copy, keepOf(review));
    } catch (e) {
      return { kind: 'unreadable', reason: refusalFromError(e).reason };
    }
    const what = changedBetween(review, next, copy);
    if (what !== null) {
      if (current()) setReview(next);
      return { kind: 'changed', what };
    }
    if (current()) setReview(next);
    const blockers = reviewBlockers(next, shortText(next.loan.principalAsset));
    if (blockers.length > 0) return { kind: 'refused', refusal: { code: next.verdict.refusals[0]?.code ?? 'RepayBlocked', reason: blockers[0]!, reopensAt: null, remedy: null } };
    return { kind: 'ok' };
  };

  const blockers = review ? reviewBlockers(review, shortText(review.loan.principalAsset)) : [];
  const gate = review
    ? {
        ready: blockers.length === 0,
        node: (
          <div className="repay-gate">
            {blockers.map((b) => (
              <Notice key={b} tone="danger" tier="A">
                {b}
              </Notice>
            ))}
            <GraceClock dates={{ maturity: review.maturity, graceEnd: review.graceEnd, chainNow: review.payoff.chainNow, readAt: review.readAt }} />
            <WhyLink summaryKey="repay.payoffSummary" detailKey="repay.payoffWhy" />
          </div>
        ),
      }
    : undefined;

  const describeAsset = (a: Hex) => {
    const m = meta?.[a.toLowerCase()];
    return m && m.decimals !== null ? { symbol: m.symbol ?? shortAddress(a), decimals: m.decimals } : null;
  };

  const close = () => {
    setReview(null);
    setStep(null);
    reviewOpened.current = false;
    onClose();
  };

  return (
    <div className="repay-loan" data-testid="repay-panel">
      {loadError !== null && (
        <Notice tone="warn" tier="A">
          {format('flow.unreadable', { reason: loadError })}{' '}
          <button type="button" className="btn" onClick={() => void load()}>
            {text('consent.retry')}
          </button>
        </Notice>
      )}
      <ActionFlow
        tx={tx}
        publicQueue
        identity={identity}
        reviewedFor={review?.identity ?? tx.frozen?.identity ?? identity}
        receipt={review ? repayReceipt(review, account, meta, copy) : null}
        recheck={recheck}
        describeAsset={describeAsset}
        explorer={chain.blockExplorer}
        next={null}
        gate={gate}
        onClose={close}
      />
    </div>
  );
}
