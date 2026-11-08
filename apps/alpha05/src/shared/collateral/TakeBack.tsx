import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Log } from 'viem';
import { useConfig } from 'wagmi';
import { writeContract } from 'wagmi/actions';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { useCopy } from '../copy/useCopy';
import { checkTakeBack } from '../eligibility/takeBack';
import { refusalFromError, StatedRefusal } from '../eligibility/refusal';
import { WhyLink } from '../help/WhyLink';
import { moved } from '../offers/acceptOutcome';
import { parseAmount } from '../post/postModel';
import { exactTokenAmount, tokenAmount, type TokenMetaMap } from '../reads/tokens';
import type { LegOutcome } from '../tx/outcome';
import { askThrough } from '../tx/simulate';
import { holdsFlow, useStoredValue, useTxEntry, useTxNote } from '../tx/txStore';
import { useMounted, useReviewRefresh } from '../tx/useReviewRefresh';
import { useTrackedTx } from '../tx/useTrackedTx';
import { ActionFlow, reviewIdentity, type Recheck } from '../ui/ActionFlow';
import { FormField } from '../ui/FormField';
import { Notice } from '../ui/Notice';
import { formatBps, formatScaled, shortAddress } from '../ui/format';
import { payoutOutcome } from '../protection/payout';
import { routedLeg } from '../protection/payoutCopy';
import { collateralWithdrawn } from './collateralLog';
import { takeBackReceipt } from './takeBackReceipt';
import { readTakeBackReview, takeBackBlockers, takeBackChanged, WITHDRAW, type TakeBackReview } from './takeBackReview';

type Hex = `0x${string}`;

/** The store key a loan's withdrawal keeps its state under: one per loan. */
export function takeBackKey(loanId: bigint): string {
  return `position.takeBack.${loanId.toString()}`;
}

interface TakeBackProps {
  loanId: bigint;
  chain: SupportedChain;
  own: OwnStateClient;
  meta: TokenMetaMap | null;
  /** The collateral token, as the loan page read it: the form's unit. The
   *  review reads it again. */
  asset: Hex;
  onClose: () => void;
}

/**
 * LN-32 — take back part of a loan's collateral, by the borrower position's
 * holder. The reader first chooses the amount (more than nothing, at most
 * the protocol's own limit now, which moves with prices); the review states
 * the collateral before and after, where it goes, the limit, the loan's
 * health factor and loan-to-value now, and every consequence. No approval is
 * asked: nothing leaves the wallet. The withdrawal is sent only after the
 * protocol's dry run passes, and its outcome is measured from the
 * transaction's own logs: the collateral it left, the protocol's health
 * factor and loan-to-value after, and what arrived in the wallet.
 */
export function TakeBack(props: TakeBackProps) {
  const key = takeBackKey(props.loanId);
  const entry = useTxEntry(key);
  const [amount, setAmount] = useStoredValue<bigint>(`${key}:amount`);
  if (amount === null && !holdsFlow(entry.phase)) return <TakeBackForm {...props} onChosen={setAmount} />;
  return <TakeBackFlow {...props} amount={amount ?? 0n} onChangeAmount={() => setAmount(null)} onClose={() => (setAmount(null), props.onClose())} />;
}

/** The amount form: checked as it is typed against the protocol's limit. */
function TakeBackForm({ loanId, chain, own, meta, asset, onClose, onChosen }: TakeBackProps & { onChosen: (v: bigint) => void }) {
  const { text, format } = useCopy();
  const key = takeBackKey(loanId);
  const [input, setInput] = useStoredValue<string>(`${key}:input`);
  const [asked, setAsked] = useState(false);
  const [max, setMax] = useState<bigint | null | undefined>(undefined);
  const m = meta?.[asset.toLowerCase()];
  const decimals = m?.decimals ?? null;
  const symbol = m?.symbol ?? shortAddress(asset);
  const amountText = (v: bigint) => tokenAmount(v, asset, meta, format);

  useEffect(() => {
    let live = true;
    own
      .read((c) => c.readContract({ address: chain.diamondAddress, abi: WITHDRAW, functionName: 'calculateMaxWithdrawable', args: [loanId] }) as Promise<bigint>)
      .then(
        (x) => live && setMax(x.value),
        () => live && setMax(null),
      );
    return () => {
      live = false;
    };
  }, [own, chain.diamondAddress, loanId]);

  const typed = input ?? '';
  const parsed = decimals === null ? null : parseAmount(typed, decimals);
  const error = (() => {
    if (decimals === null) return text('takeBack.decimalsUnread');
    if (!parsed) return null;
    if (!parsed.ok) {
      if (parsed.error === 'empty' || parsed.error === 'zero') return text('takeBack.amountZero');
      if (parsed.error === 'invalid') return text('request.errInvalid');
      return format('request.errDecimals', { symbol, decimals: String(decimals) });
    }
    const check = checkTakeBack(parsed.value, max ?? null);
    if (check.ok) return null;
    return check.why === 'zero' ? text('takeBack.amountZero') : format('takeBack.overLimit', { max: amountText(max ?? 0n) });
  })();
  const ready = parsed?.ok === true && error === null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setAsked(true);
    if (ready && parsed?.ok) onChosen(parsed.value);
  };

  const hint = typeof max === 'bigint' ? format('takeBack.amountHint', { max: amountText(max) }) : text('takeBack.amountHintUnread');

  return (
    <form className="partial-form" onSubmit={submit} noValidate data-testid="take-back-form">
      <h3>{text('takeBack.formTitle')}</h3>
      <FormField
        label={format('takeBack.amountLabel', { symbol })}
        hint={hint}
        error={decimals === null || asked || (typed !== '' && error !== text('takeBack.amountZero')) ? error : null}
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
            data-testid="take-back-amount"
          />
        )}
      </FormField>
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={decimals === null || max === undefined} data-testid="take-back-review">
          {text('takeBack.review')}
        </button>
        <button type="button" className="btn" onClick={() => (setInput(null), onClose())} data-testid="take-back-cancel">
          {text('flow.cancel')}
        </button>
      </div>
    </form>
  );
}

/** The review and the transaction, for one chosen amount. */
function TakeBackFlow({ loanId, chain, own, meta, amount, onChangeAmount, onClose }: TakeBackProps & { amount: bigint; onChangeAmount: () => void }) {
  const copy = useCopy();
  const { text, format } = copy;
  const config = useConfig();
  const diamond = chain.diamondAddress;
  const account = own.account;
  const identity = reviewIdentity(own);
  const flowKey = takeBackKey(loanId);
  const [review, setReview] = useStoredValue<TakeBackReview>(`${flowKey}:review`);
  const [, setInput] = useStoredValue<string>(`${flowKey}:input`);
  const [loadError, setLoadError] = useState<string | null>(null);
  const setStep = useTxNote(flowKey);

  const exact = (asset: Hex, v: bigint) => exactTokenAmount(v, asset, meta, format);
  const amountText = (asset: Hex) => (v: bigint) => tokenAmount(v, asset, meta, format);

  const tx = useTrackedTx({
    key: flowKey,
    chainId: chain.chainId,
    account,
    sources: own.sources,
    send: async () => {
      if (!review) throw new Error('no withdrawal under review');
      const stop = (reason: string): never => {
        throw new StatedRefusal({ code: 'TakeBackStopped', reason, reopensAt: null, remedy: null });
      };
      // The dry run again, at send: the protocol's own verdict on this
      // withdrawal now, since its limit moves with prices.
      const args = [loanId, review.amount] as const;
      const dry = await askThrough(own, (c) => c.simulateContract({ address: diamond, abi: WITHDRAW, functionName: 'partialWithdrawCollateral', args, account }));
      if (dry.kind === 'reverted') return stop(format('repay.dryRunRefused', { reason: refusalFromError(dry.error).reason }));
      if (dry.kind === 'unreadable') return stop(format('flow.unreadable', { reason: dry.reason }));
      setStep(format('accept.stepOf', { n: '1', total: '1', what: text('takeBack.stepSend') }));
      return writeContract(config, { address: diamond, abi: WITHDRAW, functionName: 'partialWithdrawCollateral', args, chainId: chain.chainId, account });
    },
    measure: async (receipt) => (review ? measure(review, receipt.logs) : []),
    release: async () => null,
  });

  /** What the withdrawal left, from its own logs, and what reached the
   *  wallet. */
  const measure = (r: TakeBackReview, logs: readonly Log[]): LegOutcome[] => {
    const asset = r.loan.collateralAsset;
    const legs: LegOutcome[] = [];
    const expected = r.loan.collateralAmount - r.amount;
    const taken = collateralWithdrawn(logs, diamond, loanId);
    if (taken === null) legs.push({ status: 'not-done', label: format('takeBack.legLeft', { amount: exact(asset, expected) }), reason: text('takeBack.notTaken') });
    else {
      const label = format('takeBack.legLeft', { amount: tokenAmount(taken.newCollateralAmount, asset, meta, format) });
      legs.push(
        taken.newCollateralAmount === expected
          ? { status: 'done', label }
          : { status: 'not-done', label, reason: format('takeBack.leftOther', { amount: exact(asset, taken.newCollateralAmount), expected: exact(asset, expected) }) },
      );
      legs.push(
        taken.newHf === 0n
          ? { status: 'unknown', label: text('addColl.rowHfNow'), reason: text('takeBack.hfAfterNone') }
          : { status: 'done', label: format('addColl.legHf', { hf: formatScaled(taken.newHf), ltv: formatBps(taken.newLtv) }) },
      );
    }
    const routed = payoutOutcome(logs, diamond, account, asset);
    if (routed) {
      const label = routedLeg(routed, tokenAmount(routed.amount, asset, meta, format), r.protection, copy);
      legs.push(
        routed.amount === r.amount
          ? { status: 'done', label }
          : { status: 'unknown', label, reason: format('takeBack.routedOther', { amount: exact(asset, routed.amount), expected: exact(asset, r.amount) }) },
      );
      return legs;
    }
    const received = moved(logs, asset, null, account);
    const receivedLabel = format('takeBack.legReceived', { amount: tokenAmount(received, asset, meta, format) });
    legs.push(
      received === r.amount
        ? { status: 'done', label: receivedLabel }
        : {
            status: received === 0n ? 'not-done' : 'unknown',
            label: receivedLabel,
            reason: format('takeBack.receivedOther', { amount: exact(asset, received), expected: exact(asset, r.amount) }),
          },
    );
    return legs;
  };

  const mounted = useMounted();
  const load = async () => {
    try {
      const next = await readTakeBackReview(own, diamond, loanId, amount, identity, copy);
      if (!mounted.current) return;
      setLoadError(null);
      setReview(next);
    } catch (e) {
      setLoadError(refusalFromError(e).reason);
    }
  };

  // RB-RAILS: read again each block while the review is on screen.
  const onReview = tx.phase.kind === 'review' && review !== null && review.loanId === loanId && review.amount === amount;
  useReviewRefresh<TakeBackReview>({
    chainId: chain.chainId,
    active: onReview,
    review,
    read: (before) => readTakeBackReview(own, diamond, before.loanId, before.amount, before.identity, copy),
    sameSubject: (a, b) => a.loanId === b.loanId && a.amount === b.amount,
    changed: (before, next) => takeBackChanged(before, next, copy) !== null,
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
      readTakeBackReview(own, diamond, loanId, amount, identity, copy).then(
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

  const recheck = async (current: () => boolean): Promise<Recheck> => {
    if (!review) return { kind: 'unreadable', reason: text('flow.reading') };
    let next: TakeBackReview;
    try {
      next = await readTakeBackReview(own, diamond, loanId, review.amount, review.identity, copy);
    } catch (e) {
      return { kind: 'unreadable', reason: refusalFromError(e).reason };
    }
    const what = takeBackChanged(review, next, copy);
    if (current()) setReview(next);
    if (what !== null) return { kind: 'changed', what };
    const blockers = takeBackBlockers(next, copy, amountText(next.loan.collateralAsset));
    if (blockers.length > 0)
      return {
        kind: 'refused',
        refusal: {
          code: next.verdict.refusals[0]?.code ?? (next.dryRun !== null && next.dryRun !== 'unread' ? next.dryRun.code : 'TakeBackBlocked'),
          reason: blockers[0]!,
          reopensAt: null,
          remedy: null,
        },
      };
    return { kind: 'ok' };
  };

  const changeAmount = () => {
    tx.reset();
    setReview(null);
    setStep(null);
    onChangeAmount();
  };

  const blockers = review ? takeBackBlockers(review, copy, amountText(review.loan.collateralAsset)) : [];
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
            <WhyLink summaryKey="takeBack.whySummary" detailKey="takeBack.why" />
            <button type="button" className="btn btn-link" onClick={changeAmount} data-testid="take-back-change">
              {text('takeBack.changeAmount')}
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
    <div className="repay-loan" data-testid="take-back-panel">
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
        identity={identity}
        reviewedFor={review?.identity ?? tx.frozen?.identity ?? identity}
        receipt={review ? takeBackReceipt(review, meta, copy) : null}
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
