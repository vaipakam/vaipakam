import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Abi, Log } from 'viem';
import { useConfig } from 'wagmi';
import { writeContract } from 'wagmi/actions';
import { RepayFacetABI, RepayPeriodicFacetABI } from '@vaipakam/contracts/abis';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { useCopy } from '../copy/useCopy';
import { checkPartialAmount } from '../eligibility/partialRepay';
import { refusalFromError, StatedRefusal } from '../eligibility/refusal';
import { WhyLink } from '../help/WhyLink';
import { moved } from '../offers/acceptOutcome';
import { parseAmount } from '../post/postModel';
import { exactTokenAmount, tokenAmount, type TokenMetaMap } from '../reads/tokens';
import type { AnchoredReader } from '../tx/anchored';
import { allowanceSteps } from '../tx/approval';
import { allowanceMoved, approvalFlow } from '../tx/approvalFlow';
import { cleanUpLeg } from '../tx/cleanUp';
import type { LegOutcome } from '../tx/outcome';
import { askThrough } from '../tx/simulate';
import { holdsFlow, useStoredValue, useTxEntry, useTxNote } from '../tx/txStore';
import { useMounted, useReviewRefresh } from '../tx/useReviewRefresh';
import { useTrackedTx } from '../tx/useTrackedTx';
import { ActionFlow, reviewIdentity, type Recheck } from '../ui/ActionFlow';
import { FormField } from '../ui/FormField';
import { Notice } from '../ui/Notice';
import { GraceClock } from './GraceClock';
import { formatUtc, shortAddress } from '../ui/format';
import { allowanceFigure } from './approvalCap';
import { partialReceipt } from './partialReceipt';
import { partialPrincipalAfter } from './repaidLog';
import { amountSentence, partialBlockers, partialChanged, partialPromptCount, readPartialFloor, readPartialReview, type PartialReview } from './partialReview';

type Hex = `0x${string}`;

const REPAY_ABI = RepayFacetABI as Abi;
const PERIODIC_ABI = RepayPeriodicFacetABI as Abi;

/** The store key a loan's partial repayment keeps its state under: one per
 *  loan, apart from the full repayment's. */
export function partialKey(loanId: bigint): string {
  return `position.partial.${loanId.toString()}`;
}

interface PartialRepayProps {
  loanId: bigint;
  chain: SupportedChain;
  own: OwnStateClient;
  meta: TokenMetaMap | null;
  /** The lending asset and the principal still owed, as the loan page read
   *  them: the form's hint and first check. The review reads both again. */
  asset: Hex;
  principal: bigint;
  onClose: () => void;
}

/**
 * LN-22 / LN-64 — pay part of a loan's principal, by the borrower
 * position's holder. The reader first chooses the principal part (at least
 * the protocol's minimum part and less than the whole principal); the
 * review then states that part, the interest accrued so far that it adds
 * (exact, or at most, see partialReview), and the principal left. The
 * wallet approves exactly the most it can take by a moment a short while
 * ahead, the payment is sent only after a dry run passes, and what it does
 * not use of the approval is put back afterwards. The outcome is measured
 * from the transaction's own logs (the principal the payment left, what
 * left the wallet) and from the chain at its block (where the interest
 * period stands afterwards).
 */
export function PartialRepay(props: PartialRepayProps) {
  const key = partialKey(props.loanId);
  const entry = useTxEntry(key);
  const [amount, setAmount] = useStoredValue<bigint>(`${key}:amount`);
  if (amount === null && !holdsFlow(entry.phase)) return <PartialForm {...props} onChosen={setAmount} />;
  return <PartialFlow {...props} amount={amount ?? 0n} onChangeAmount={() => setAmount(null)} onClose={() => (setAmount(null), props.onClose())} />;
}

/** The amount form: the principal part, checked as it is typed against the
 *  protocol's own bounds. */
function PartialForm({ loanId, chain, own, meta, asset, principal, onClose, onChosen }: PartialRepayProps & { onChosen: (v: bigint) => void }) {
  const { text, format } = useCopy();
  const key = partialKey(loanId);
  const [input, setInput] = useStoredValue<string>(`${key}:input`);
  const [asked, setAsked] = useState(false);
  const [floor, setFloor] = useState<bigint | null | undefined>(undefined);
  const m = meta?.[asset.toLowerCase()];
  const decimals = m?.decimals ?? null;
  const symbol = m?.symbol ?? shortAddress(asset);
  const amountText = (v: bigint) => tokenAmount(v, asset, meta, format);

  useEffect(() => {
    let live = true;
    own
      .read((c) => readPartialFloor(c, chain.diamondAddress, asset, principal))
      .then(
        (x) => live && setFloor(x.value),
        () => live && setFloor(null),
      );
    return () => {
      live = false;
    };
  }, [own, chain.diamondAddress, asset, principal]);

  const typed = input ?? '';
  const parsed = decimals === null ? null : parseAmount(typed, decimals);
  const error = (() => {
    if (decimals === null) return text('partial.decimalsUnread');
    if (!parsed) return null;
    if (!parsed.ok) {
      if (parsed.error === 'empty') return text('partial.amountZero');
      if (parsed.error === 'invalid') return text('request.errInvalid');
      if (parsed.error === 'zero') return text('partial.amountZero');
      return format('request.errDecimals', { symbol, decimals: String(decimals) });
    }
    if (floor === undefined) return null;
    const check = checkPartialAmount(parsed.value, principal, floor);
    return check.ok ? null : amountSentence(check.why, principal, floor, { text, format }, amountText);
  })();
  const ready = parsed?.ok === true && floor !== undefined && error === null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setAsked(true);
    if (ready && parsed?.ok) onChosen(parsed.value);
  };

  const hint =
    floor === undefined || floor === null
      ? format('partial.amountHintNoFloor', { principal: amountText(principal) })
      : format('partial.amountHint', { min: amountText(floor), principal: amountText(principal) });

  return (
    <form className="partial-form" onSubmit={submit} noValidate data-testid="partial-form">
      <h3>{text('partial.formTitle')}</h3>
      <FormField
        label={format('partial.amountLabel', { symbol })}
        hint={hint}
        error={decimals === null || asked || (typed !== '' && error !== text('partial.amountZero')) ? error : null}
      >
        {({ id, describedBy, invalid }) => (
          <input
            id={id}
            inputMode="decimal"
            autoComplete="off"
            aria-describedby={describedBy}
            aria-invalid={invalid}
            value={typed}
            disabled={decimals === null}
            onChange={(e) => setInput(e.target.value)}
            data-testid="partial-amount"
          />
        )}
      </FormField>
      <p className="tier-b">{text('partial.interestHint')}</p>
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={decimals === null || floor === undefined} data-testid="partial-review">
          {text('partial.review')}
        </button>
        <button type="button" className="btn" onClick={() => (setInput(null), onClose())} data-testid="partial-cancel">
          {text('flow.cancel')}
        </button>
      </div>
    </form>
  );
}

/** The review and the transaction, for one chosen amount. */
function PartialFlow({ loanId, chain, own, meta, amount, onChangeAmount, onClose }: PartialRepayProps & { amount: bigint; onChangeAmount: () => void }) {
  const copy = useCopy();
  const { text, format } = copy;
  const config = useConfig();
  const diamond = chain.diamondAddress;
  const account = own.account;
  const identity = reviewIdentity(own);
  const flowKey = partialKey(loanId);
  const [review, setReview] = useStoredValue<PartialReview>(`${flowKey}:review`);
  const [, setInput] = useStoredValue<string>(`${flowKey}:input`);
  const [loadError, setLoadError] = useState<string | null>(null);
  const setStep = useTxNote(flowKey);
  /** The approval this flow made and has not yet seen used or put back. */
  const approvalLeft = useRef<{ token: Hex; prior: bigint; amount: bigint; since: bigint | null } | null>(null);
  /** After a payment that took effect: what of the approval it should have
   *  left, to put back. */
  const leftover = useRef<{ token: Hex; prior: bigint; expect: bigint; since: bigint } | null>(null);

  const exact = (asset: Hex, v: bigint) => exactTokenAmount(v, asset, meta, format);
  const { readAllowance, allowanceIo, approveExactly, putBack } = approvalFlow({ own, config, chainId: chain.chainId, diamond, copy, exactAmount: exact, setStep });

  const tx = useTrackedTx({
    key: flowKey,
    chainId: chain.chainId,
    account,
    sources: own.sources,
    send: async () => {
      if (!review) throw new Error('no payment under review');
      const r = review;
      const asset = r.loan.principalAsset;
      const reach = r.totalBy;
      const total = partialPromptCount(r);
      let n = 0;
      const say = (what: string) => setStep(format('accept.stepOf', { n: String(++n), total: String(total), what }));
      approvalLeft.current = null;
      leftover.current = null;

      const io = allowanceIo(asset, (v, i, of) => say(of === 2 && i === 0 ? text('approval.stepZero') : format('partial.stepApprove', { amount: exact(asset, v) })));
      const prior = await readAllowance(asset);
      // Exactly the reviewed maximum, lowered too: the allowance is the only
      // cap on what `repayPartial` can take (approvalCap). The prior
      // allowance is what a stop puts back and what the review stated.
      if (prior !== r.allowance) throw allowanceMoved(copy);
      const steps = await allowanceSteps(io, prior, reach);
      if (steps.length !== r.approvalSteps) throw allowanceMoved(copy);
      const approved = steps.length > 0;
      let since: bigint | null = null;
      if (approved) {
        since = await approveExactly(io, asset, reach, prior);
        approvalLeft.current = { token: asset, prior, amount: reach, since };
      }

      const stop = async (reason: string): Promise<never> => {
        if (!approved) throw new StatedRefusal({ code: 'PartialStopped', reason, reopensAt: null, remedy: null });
        approvalLeft.current = null;
        const after = await putBack(asset, prior, reach, since);
        throw new StatedRefusal({ code: 'PartialStopped', reason: `${reason} ${after.sentence}`, reopensAt: null, remedy: null });
      };

      // The dry run: the protocol's own verdict on this payment, now.
      const args = [loanId, r.amount] as const;
      const dry = await askThrough(own, (c) => c.simulateContract({ address: diamond, abi: REPAY_ABI, functionName: 'repayPartial', args, account }));
      if (dry.kind === 'reverted') return stop(format('repay.dryRunRefused', { reason: refusalFromError(dry.error).reason }));
      if (dry.kind === 'unreadable') return stop(format('flow.unreadable', { reason: dry.reason }));

      say(text('partial.stepSend'));
      try {
        return await writeContract(config, { address: diamond, abi: REPAY_ABI, functionName: 'repayPartial', args, chainId: chain.chainId, account });
      } catch (e) {
        return stop(format('repay.stoppedAfterApproval', { reason: refusalFromError(e).reason }));
      }
    },
    unwind: async () => {
      const left = approvalLeft.current;
      approvalLeft.current = null;
      if (!left) return null;
      const after = await putBack(left.token, left.prior, left.amount, left.since);
      return cleanUpLeg(after, format('approval.legBack', { amount: allowanceFigure(left.prior, left.token, meta, copy) }));
    },
    measure: async (receipt, at) => (review ? measure(review, receipt.logs, at) : []),
    release: async () => {
      const left = leftover.current;
      leftover.current = null;
      if (!left) return null;
      const after = await putBack(left.token, left.prior, left.expect, left.since);
      return cleanUpLeg(after, format('repay.legPutBack', { amount: allowanceFigure(left.prior, left.token, meta, copy) }));
    },
  });

  /** The principal the part payment left (its own log), what left the
   *  wallet, and where the interest period stands at the receipt's block. */
  const measure = async (r: PartialReview, logs: readonly Log[], at: AnchoredReader): Promise<LegOutcome[]> => {
    const asset = r.loan.principalAsset;
    const legs: LegOutcome[] = [];
    const expected = r.loan.principal - r.amount;
    // The part payment's own log, not the principal at the block: another
    // transaction later in that block (a liquidation) can move it on.
    const principal = partialPrincipalAfter(logs, diamond, loanId);
    if (principal === null) legs.push({ status: 'not-done', label: format('partial.legPrincipal', { amount: exact(asset, expected) }), reason: text('partial.notPaid') });
    else {
      const label = format('partial.legPrincipal', { amount: tokenAmount(principal, asset, meta, format) });
      legs.push(
        principal === expected
          ? { status: 'done', label }
          : { status: 'not-done', label, reason: format('partial.principalOther', { amount: exact(asset, principal), expected: exact(asset, expected) }) },
      );
    }
    // What left the wallet: the part, and the interest as of this block,
    // which is at most the review's upper figure.
    const paid = moved(logs, asset, account, null);
    const left = approvalLeft.current;
    approvalLeft.current = null;
    if (left && paid <= left.amount) leftover.current = { token: left.token, prior: left.prior, expect: left.amount - paid, since: at.blockNumber };
    const low = r.amount + (r.interestExact ? r.interestNow : 0n);
    const paidLabel = format('repay.legPaid', { amount: tokenAmount(paid, asset, meta, format) });
    if (paid >= low && paid <= r.totalBy) legs.push({ status: 'done', label: paidLabel });
    else
      legs.push({
        status: paid === 0n ? 'not-done' : 'unknown',
        label: paidLabel,
        reason: format('partial.paidOther', { amount: exact(asset, paid), part: exact(asset, r.amount), interest: exact(asset, r.interestBy) }),
      });
    if (r.period) {
      const before = r.period;
      try {
        const p = await at.read(
          (c, b) =>
            c.readContract({ address: diamond, abi: PERIODIC_ABI, functionName: 'previewPeriodicSettle', args: [loanId], ...b }) as Promise<
              readonly [number, bigint, bigint, bigint, bigint, bigint, boolean]
            >,
        );
        const [, periodEndAt, , , paidToward] = p;
        legs.push(
          periodEndAt > before.periodEndAt
            ? { status: 'done', label: format('partial.legPeriodMoved', { time: formatUtc(Number(periodEndAt)) }) }
            : {
                status: 'done',
                label: format('partial.legPeriodPaid', { amount: tokenAmount(paidToward, asset, meta, format), time: formatUtc(Number(periodEndAt)) }),
              },
        );
      } catch {
        legs.push({ status: 'unknown', label: text('partial.changedPeriod'), reason: text('partial.periodAfterUnread') });
      }
    }
    return legs;
  };

  const mounted = useMounted();
  const load = async () => {
    try {
      const next = await readPartialReview(own, diamond, loanId, amount, identity, copy);
      if (!mounted.current) return;
      setLoadError(null);
      setReview(next);
    } catch (e) {
      setLoadError(refusalFromError(e).reason);
    }
  };

  const keepOf = (r: PartialReview) => ({ by: r.payoff.by, capped: r.capped });

  // RB-RAILS: read again each block while the review is on screen.
  const onReview = tx.phase.kind === 'review' && review !== null && review.loanId === loanId && review.amount === amount;
  useReviewRefresh<PartialReview>({
    chainId: chain.chainId,
    active: onReview,
    review,
    read: (before) => readPartialReview(own, diamond, before.loanId, before.amount, before.identity, copy, keepOf(before)),
    sameSubject: (a, b) => a.loanId === b.loanId && a.amount === b.amount,
    changed: (before, next) => partialChanged(before, next, copy) !== null,
    setReview,
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
    if (review === null || review.loanId !== loanId || review.amount !== amount || review.identity !== identity) {
      setReview(null);
      let live = true;
      readPartialReview(own, diamond, loanId, amount, identity, copy).then(
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
    // Opened once per loan and amount; the tracker and the stored review
    // carry the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loanId, amount]);

  const amountText = (asset: Hex) => (v: bigint) => tokenAmount(v, asset, meta, format);

  const recheck = async (current: () => boolean): Promise<Recheck> => {
    if (!review) return { kind: 'unreadable', reason: text('flow.reading') };
    let next: PartialReview;
    try {
      next = await readPartialReview(own, diamond, loanId, review.amount, review.identity, copy, keepOf(review));
    } catch (e) {
      return { kind: 'unreadable', reason: refusalFromError(e).reason };
    }
    const what = partialChanged(review, next, copy);
    if (current()) setReview(next);
    if (what !== null) return { kind: 'changed', what };
    const blockers = partialBlockers(next, copy, amountText(next.loan.principalAsset));
    if (blockers.length > 0) return { kind: 'refused', refusal: { code: next.verdict.refusals[0]?.code ?? 'PartialBlocked', reason: blockers[0]!, reopensAt: null, remedy: null } };
    return { kind: 'ok' };
  };

  const changeAmount = () => {
    tx.reset();
    setReview(null);
    setStep(null);
    onChangeAmount();
  };

  const blockers = review ? partialBlockers(review, copy, amountText(review.loan.principalAsset)) : [];
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
            <GraceClock dates={{ maturity: review.maturity, graceEnd: review.graceEnd, chainNow: review.payoff.chainNow, chainReadAt: review.payoff.chainReadAt }} />
            <WhyLink summaryKey="partial.whySummary" detailKey="partial.why" />
            <button type="button" className="btn btn-link" onClick={changeAmount} data-testid="partial-change">
              {text('partial.changeAmount')}
            </button>
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
    setInput(null);
    setStep(null);
    reviewOpened.current = false;
    onClose();
  };

  return (
    <div className="repay-loan" data-testid="partial-panel">
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
        receipt={review ? partialReceipt(review, meta, copy) : null}
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
