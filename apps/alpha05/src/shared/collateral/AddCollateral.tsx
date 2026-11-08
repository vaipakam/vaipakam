import { useEffect, useRef, useState, type FormEvent } from 'react';
import { erc20Abi, type Abi, type Log } from 'viem';
import { useConfig } from 'wagmi';
import { writeContract } from 'wagmi/actions';
import { AddCollateralFacetABI } from '@vaipakam/contracts/abis';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { useCopy } from '../copy/useCopy';
import { checkTopUp } from '../eligibility/addCollateral';
import { refusalFromError, StatedRefusal } from '../eligibility/refusal';
import { WhyLink } from '../help/WhyLink';
import { moved } from '../offers/acceptOutcome';
import { parseAmount } from '../post/postModel';
import { exactTokenAmount, tokenAmount, type TokenMetaMap } from '../reads/tokens';
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
import { formatBps, formatScaled, shortAddress } from '../ui/format';
import { allowanceFigure } from '../repay/approvalCap';
import { addReceipt } from './addReceipt';
import { addBlockers, addChanged, addPromptCount, inFallback, readAddReview, type AddReview } from './addReview';
import { collateralAdded, curedFromFallback } from './collateralLog';

type Hex = `0x${string}`;

const ADD_ABI = AddCollateralFacetABI as Abi;

/** The store key a loan's top-up keeps its state under: one per loan. */
export function addCollateralKey(loanId: bigint): string {
  return `position.addCollateral.${loanId.toString()}`;
}

interface AddCollateralProps {
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
 * LN-31 — add collateral to a loan, by the borrower position's holder. The
 * reader first chooses the amount (more than nothing, within the wallet's
 * balance); the review states the collateral before and after, where it is
 * held, the loan's health factor and loan-to-value now, the approval, and
 * every consequence. The wallet approves exactly the amount when its
 * standing approval does not cover it (a top-up pulls exactly the amount
 * chosen, so a larger approval is left as it is), the top-up is sent only
 * after a dry run passes, and an approval it made is put back if the top-up
 * does not go through. The outcome is measured from the transaction's own
 * logs: the collateral it left, the protocol's health factor and
 * loan-to-value after, whether a loan in fallback was cured, and what left
 * the wallet.
 */
export function AddCollateral(props: AddCollateralProps) {
  const key = addCollateralKey(props.loanId);
  const entry = useTxEntry(key);
  const [amount, setAmount] = useStoredValue<bigint>(`${key}:amount`);
  if (amount === null && !holdsFlow(entry.phase)) return <AddForm {...props} onChosen={setAmount} />;
  return <AddFlow {...props} amount={amount ?? 0n} onChangeAmount={() => setAmount(null)} onClose={() => (setAmount(null), props.onClose())} />;
}

/** The amount form: checked as it is typed against the wallet's balance. */
function AddForm({ loanId, own, meta, asset, onClose, onChosen }: AddCollateralProps & { onChosen: (v: bigint) => void }) {
  const { text, format } = useCopy();
  const key = addCollateralKey(loanId);
  const [input, setInput] = useStoredValue<string>(`${key}:input`);
  const [asked, setAsked] = useState(false);
  const [balance, setBalance] = useState<bigint | null | undefined>(undefined);
  const m = meta?.[asset.toLowerCase()];
  const decimals = m?.decimals ?? null;
  const symbol = m?.symbol ?? shortAddress(asset);
  const amountText = (v: bigint) => tokenAmount(v, asset, meta, format);

  useEffect(() => {
    let live = true;
    own
      .read((c) => c.readContract({ address: asset, abi: erc20Abi, functionName: 'balanceOf', args: [own.account] }))
      .then(
        (x) => live && setBalance(x.value),
        () => live && setBalance(null),
      );
    return () => {
      live = false;
    };
  }, [own, asset]);

  const typed = input ?? '';
  const parsed = decimals === null ? null : parseAmount(typed, decimals);
  const error = (() => {
    if (decimals === null) return text('addColl.decimalsUnread');
    if (!parsed) return null;
    if (!parsed.ok) {
      if (parsed.error === 'empty' || parsed.error === 'zero') return text('addColl.amountZero');
      if (parsed.error === 'invalid') return text('request.errInvalid');
      return format('request.errDecimals', { symbol, decimals: String(decimals) });
    }
    const check = checkTopUp(parsed.value, balance ?? null);
    if (check.ok) return null;
    return check.why === 'zero' ? text('addColl.amountZero') : format('addColl.amountOver', { balance: amountText(balance ?? 0n) });
  })();
  const ready = parsed?.ok === true && error === null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setAsked(true);
    if (ready && parsed?.ok) onChosen(parsed.value);
  };

  const hint = typeof balance === 'bigint' ? format('addColl.amountHint', { balance: amountText(balance) }) : text('addColl.amountHintUnread');

  return (
    <form className="partial-form" onSubmit={submit} noValidate data-testid="add-collateral-form">
      <h3>{text('addColl.formTitle')}</h3>
      <FormField
        label={format('addColl.amountLabel', { symbol })}
        hint={hint}
        error={decimals === null || asked || (typed !== '' && error !== text('addColl.amountZero')) ? error : null}
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
            data-testid="add-collateral-amount"
          />
        )}
      </FormField>
      <p className="tier-b">{text('addColl.sameToken')}</p>
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={decimals === null || balance === undefined} data-testid="add-collateral-review">
          {text('addColl.review')}
        </button>
        <button type="button" className="btn" onClick={() => (setInput(null), onClose())} data-testid="add-collateral-cancel">
          {text('flow.cancel')}
        </button>
      </div>
    </form>
  );
}

/** The review and the transaction, for one chosen amount. */
function AddFlow({ loanId, chain, own, meta, amount, onChangeAmount, onClose }: AddCollateralProps & { amount: bigint; onChangeAmount: () => void }) {
  const copy = useCopy();
  const { text, format } = copy;
  const config = useConfig();
  const diamond = chain.diamondAddress;
  const account = own.account;
  const identity = reviewIdentity(own);
  const flowKey = addCollateralKey(loanId);
  const [review, setReview] = useStoredValue<AddReview>(`${flowKey}:review`);
  const [, setInput] = useStoredValue<string>(`${flowKey}:input`);
  const [loadError, setLoadError] = useState<string | null>(null);
  const setStep = useTxNote(flowKey);
  /** The approval this flow made and has not yet seen used or put back. */
  const approvalLeft = useRef<{ token: Hex; prior: bigint; amount: bigint; since: bigint | null } | null>(null);

  const exact = (asset: Hex, v: bigint) => exactTokenAmount(v, asset, meta, format);
  const { readAllowance, allowanceIo, approveExactly, putBack } = approvalFlow({ own, config, chainId: chain.chainId, diamond, copy, exactAmount: exact, setStep });

  const tx = useTrackedTx({
    key: flowKey,
    chainId: chain.chainId,
    account,
    sources: own.sources,
    send: async () => {
      if (!review) throw new Error('no top-up under review');
      const r = review;
      const asset = r.loan.collateralAsset;
      const total = addPromptCount(r);
      let n = 0;
      const say = (what: string) => setStep(format('accept.stepOf', { n: String(++n), total: String(total), what }));
      approvalLeft.current = null;

      const io = allowanceIo(asset, (v, i, of) => say(of === 2 && i === 0 ? text('approval.stepZero') : format('addColl.stepApprove', { amount: exact(asset, v) })));
      // The allowance is read again now: it is what a stop puts back and
      // what the review stated.
      const prior = await readAllowance(asset);
      if (prior !== r.allowance) throw allowanceMoved(copy);
      const steps = prior >= r.amount ? [] : await allowanceSteps(io, prior, r.amount);
      if (steps.length !== r.approvalSteps) throw allowanceMoved(copy);
      const approved = steps.length > 0;
      let since: bigint | null = null;
      if (approved) {
        since = await approveExactly(io, asset, r.amount, prior);
        approvalLeft.current = { token: asset, prior, amount: r.amount, since };
      }

      const stop = async (reason: string): Promise<never> => {
        if (!approved) throw new StatedRefusal({ code: 'AddCollateralStopped', reason, reopensAt: null, remedy: null });
        approvalLeft.current = null;
        const after = await putBack(asset, prior, r.amount, since);
        throw new StatedRefusal({ code: 'AddCollateralStopped', reason: `${reason} ${after.sentence}`, reopensAt: null, remedy: null });
      };

      // The dry run: the protocol's own verdict on this top-up, now.
      const args = [loanId, r.amount] as const;
      const dry = await askThrough(own, (c) => c.simulateContract({ address: diamond, abi: ADD_ABI, functionName: 'addCollateral', args, account }));
      if (dry.kind === 'reverted') return stop(format('repay.dryRunRefused', { reason: refusalFromError(dry.error).reason }));
      if (dry.kind === 'unreadable') return stop(format('flow.unreadable', { reason: dry.reason }));

      say(text('addColl.stepSend'));
      try {
        return await writeContract(config, { address: diamond, abi: ADD_ABI, functionName: 'addCollateral', args, chainId: chain.chainId, account });
      } catch (e) {
        return stop(format('repay.stoppedAfterApproval', { reason: refusalFromError(e).reason }));
      }
    },
    // A sent top-up that did not take effect used none of the approval.
    unwind: async () => {
      const left = approvalLeft.current;
      approvalLeft.current = null;
      if (!left) return null;
      const after = await putBack(left.token, left.prior, left.amount, left.since);
      return cleanUpLeg(after, format('approval.legBack', { amount: allowanceFigure(left.prior, left.token, meta, copy) }));
    },
    measure: async (receipt) => (review ? measure(review, receipt.logs) : []),
    release: async () => null,
  });

  /** What the top-up left, from its own logs, and what left the wallet. */
  const measure = (r: AddReview, logs: readonly Log[]): LegOutcome[] => {
    const asset = r.loan.collateralAsset;
    const legs: LegOutcome[] = [];
    const expected = r.loan.collateralAmount + r.amount;
    const added = collateralAdded(logs, diamond, loanId);
    // A top-up that took effect used the whole approval it made.
    approvalLeft.current = null;
    if (added === null) legs.push({ status: 'not-done', label: format('addColl.legAdded', { amount: exact(asset, expected) }), reason: text('addColl.notAdded') });
    else {
      const label = format('addColl.legAdded', { amount: tokenAmount(added.newCollateralAmount, asset, meta, format) });
      legs.push(
        added.newCollateralAmount === expected
          ? { status: 'done', label }
          : { status: 'not-done', label, reason: format('addColl.addedOther', { amount: exact(asset, added.newCollateralAmount), expected: exact(asset, expected) }) },
      );
      legs.push(
        added.newHf === 0n
          ? { status: 'unknown', label: text('addColl.rowHfNow'), reason: text('addColl.hfAfterNone') }
          : { status: 'done', label: format('addColl.legHf', { hf: formatScaled(added.newHf), ltv: formatBps(added.newLtv) }) },
      );
    }
    if (inFallback(r)) {
      const label = format('addColl.legCured', { id: loanId.toString() });
      legs.push(curedFromFallback(logs, diamond, loanId) ? { status: 'done', label } : { status: 'not-done', label, reason: text('addColl.notCured') });
    }
    const paid = moved(logs, asset, account, null);
    const paidLabel = format('addColl.legMoved', { amount: tokenAmount(paid, asset, meta, format) });
    legs.push(
      paid === r.amount
        ? { status: 'done', label: paidLabel }
        : {
            status: paid === 0n ? 'not-done' : 'unknown',
            label: paidLabel,
            reason: format('addColl.movedOther', { amount: exact(asset, paid), expected: exact(asset, r.amount) }),
          },
    );
    return legs;
  };

  const mounted = useMounted();
  const load = async () => {
    try {
      const next = await readAddReview(own, diamond, loanId, amount, identity, copy);
      if (!mounted.current) return;
      setLoadError(null);
      setReview(next);
    } catch (e) {
      setLoadError(refusalFromError(e).reason);
    }
  };

  // RB-RAILS: read again each block while the review is on screen.
  const onReview = tx.phase.kind === 'review' && review !== null && review.loanId === loanId && review.amount === amount;
  useReviewRefresh<AddReview>({
    chainId: chain.chainId,
    active: onReview,
    review,
    read: (before) => readAddReview(own, diamond, before.loanId, before.amount, before.identity, copy),
    sameSubject: (a, b) => a.loanId === b.loanId && a.amount === b.amount,
    changed: (before, next) => addChanged(before, next, copy) !== null,
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
      readAddReview(own, diamond, loanId, amount, identity, copy).then(
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

  const shortText = (r: AddReview) => (short: bigint) => format('addColl.short', { amount: tokenAmount(short, r.loan.collateralAsset, meta, format) });

  const recheck = async (current: () => boolean): Promise<Recheck> => {
    if (!review) return { kind: 'unreadable', reason: text('flow.reading') };
    let next: AddReview;
    try {
      next = await readAddReview(own, diamond, loanId, review.amount, review.identity, copy);
    } catch (e) {
      return { kind: 'unreadable', reason: refusalFromError(e).reason };
    }
    const what = addChanged(review, next, copy);
    if (current()) setReview(next);
    if (what !== null) return { kind: 'changed', what };
    const blockers = addBlockers(next, shortText(next));
    if (blockers.length > 0)
      return { kind: 'refused', refusal: { code: next.verdict.refusals[0]?.code ?? 'AddCollateralBlocked', reason: blockers[0]!, reopensAt: null, remedy: null } };
    return { kind: 'ok' };
  };

  const changeAmount = () => {
    tx.reset();
    setReview(null);
    setStep(null);
    onChangeAmount();
  };

  const blockers = review ? addBlockers(review, shortText(review)) : [];
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
            <WhyLink summaryKey="addColl.whySummary" detailKey="addColl.why" />
            <button type="button" className="btn btn-link" onClick={changeAmount} data-testid="add-collateral-change">
              {text('addColl.changeAmount')}
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
    <div className="repay-loan" data-testid="add-collateral-panel">
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
        receipt={review ? addReceipt(review, meta, copy) : null}
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
