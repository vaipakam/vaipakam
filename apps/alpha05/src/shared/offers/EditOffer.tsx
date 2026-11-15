import { useEffect, useRef, useState, type FormEvent } from 'react';
import { formatUnits } from 'viem';
import { useConfig } from 'wagmi';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { useCopy, type CopyKey } from '../copy/useCopy';
import { refusalFromError, StatedRefusal } from '../eligibility/refusal';
import { WhyLink } from '../help/WhyLink';
import { parseAmount } from '../post/postModel';
import { exactTokenAmount, tokenAmount, type TokenMetaMap } from '../reads/tokens';
import { useOwnRead } from '../reads/useOwnRead';
import { allowanceFigure } from '../repay/approvalCap';
import { allowanceSteps } from '../tx/approval';
import { allowanceMoved, approvalFlow } from '../tx/approvalFlow';
import { cleanUpLeg } from '../tx/cleanUp';
import { sendWrite } from '../tx/send';
import { askThrough } from '../tx/simulate';
import { holdsFlow, useStoredValue, useTxEntry, useTxNote } from '../tx/txStore';
import { useMounted, useReviewRefresh } from '../tx/useReviewRefresh';
import { useTrackedTx } from '../tx/useTrackedTx';
import { ActionFlow, reviewIdentity, type Recheck } from '../ui/ActionFlow';
import { FormField } from '../ui/FormField';
import { Notice } from '../ui/Notice';
import { formatBps, shortAddress } from '../ui/format';
import {
  editBlockers,
  editChanged,
  editPromptCount,
  editReceipt,
  editShape,
  isLender,
  measureEdit,
  modifyArgs,
  OFFER_MUTATE,
  problemText,
  readEditReview,
  recordFrom,
  termsProblems,
  type AmountWords,
  type EditOfferRecord,
  type EditReview,
  type EditTerms,
} from './editOffer';
import { OFFER_CANCEL } from './reads';

type Hex = `0x${string}`;

/** The store key one offer's change keeps its state under, so the offer
 *  page and the why-match panel share it. */
export function editOfferKey(id: bigint): string {
  return `offers.edit.${id.toString()}`;
}

/** The form's typed figures. A missing field starts from the offer. */
export interface EditInput {
  rateMin?: string;
  rateMax?: string;
  amountMin?: string;
  amountMax?: string;
  collMin?: string;
  collMax?: string;
}

/** Whether an offer's change is open or in flight, and how to open it,
 *  optionally with figures already typed (the why-match panel's link). */
export function useEditOfferHeld(id: bigint): { held: boolean; open: (prefill?: EditInput) => void; close: () => void } {
  const key = editOfferKey(id);
  const entry = useTxEntry(key);
  const [open, setOpen] = useStoredValue<boolean>(`${key}:open`);
  const [, setInput] = useStoredValue<EditInput>(`${key}:input`);
  const [, setTerms] = useStoredValue<EditTerms>(`${key}:terms`);
  return {
    held: open === true || holdsFlow(entry.phase),
    open: (prefill) => {
      if (holdsFlow(entry.phase)) return setOpen(true);
      setTerms(null);
      setInput(prefill ?? null);
      setOpen(true);
    },
    close: () => setOpen(null),
  };
}

interface EditOfferProps {
  id: bigint;
  chain: SupportedChain;
  own: OwnStateClient;
  meta: TokenMetaMap | null;
  onClose: () => void;
}

/**
 * #3659 — change an open offer the reader posted: its rate range, its
 * amount range and its collateral, as the protocol allows for the offer.
 * The form starts from the offer as the chain holds it; the review states
 * each figure before and after, what moves between the wallet and the vault
 * (and where a returned amount lands), the approval, and every consequence.
 * The wallet approves exactly what the change pulls when its approval does
 * not cover it, the change is sent only after the protocol's dry run passes,
 * and an approval it made is put back if the change does not go through.
 * The outcome is measured from the transaction's own logs.
 */
export function EditOffer(props: EditOfferProps) {
  const key = editOfferKey(props.id);
  const entry = useTxEntry(key);
  const [terms, setTerms] = useStoredValue<EditTerms>(`${key}:terms`);
  if (terms === null && !holdsFlow(entry.phase)) return <EditForm {...props} onChosen={setTerms} />;
  return <EditFlow {...props} terms={terms} onChangeTerms={() => setTerms(null)} onClose={() => (setTerms(null), props.onClose())} />;
}

/** A typed yearly rate in basis points; "0" is a rate. */
function parseRate(t: string): bigint | 'invalid' | 'empty' {
  if (t.trim() === '') return 'empty';
  if (/^\s*0*\.?0*\s*$/.test(t)) return 0n;
  const r = parseAmount(t, 2);
  return r.ok ? r.value : r.error === 'empty' ? 'empty' : 'invalid';
}

const unitsText = (v: bigint, decimals: number) => formatUnits(v, decimals);

/** The form: the offer's own figures, read from the chain, to change. */
function EditForm({ id, chain, meta, onClose, onChosen }: EditOfferProps & { onChosen: (t: EditTerms) => void }) {
  const copy = useCopy();
  const { text, format } = copy;
  const key = editOfferKey(id);
  const diamond = chain.diamondAddress as Hex;
  const [input, setInput] = useStoredValue<EditInput>(`${key}:input`);
  const [asked, setAsked] = useState(false);
  const read = useOwnRead(['offerEditRecord', diamond, id.toString()], async (c) =>
    recordFrom((await c.readContract({ address: diamond, abi: OFFER_CANCEL, functionName: 'getOffer', args: [id] })) as Record<string, unknown>),
  );
  const o = read.data;
  if (o === null || o === undefined) {
    return (
      <div className="partial-form" data-testid="offer-edit-form">
        {read.state === 'failed' ? (
          <Notice tone="warn" tier="A">
            {format('flow.unreadable', { reason: read.error ?? '' })}
          </Notice>
        ) : (
          <p className="tier-b">{text('flow.reading')}</p>
        )}
        <button type="button" className="btn" onClick={onClose} data-testid="offer-edit-cancel">
          {text('flow.cancel')}
        </button>
      </div>
    );
  }
  return <EditFields record={o} meta={meta} input={input ?? {}} setInput={setInput} asked={asked} setAsked={setAsked} onClose={onClose} onChosen={onChosen} copy={copy} />;
}

type FieldName = keyof EditInput;

function EditFields({
  record: o,
  meta,
  input,
  setInput,
  asked,
  setAsked,
  onClose,
  onChosen,
  copy,
}: {
  record: EditOfferRecord;
  meta: TokenMetaMap | null;
  input: EditInput;
  setInput: (v: EditInput | null) => void;
  asked: boolean;
  setAsked: (v: boolean) => void;
  onClose: () => void;
  onChosen: (t: EditTerms) => void;
  copy: ReturnType<typeof useCopy>;
}) {
  const { text, format } = copy;
  const shape = editShape(o);
  const lend = isLender(o);
  const lm = meta?.[o.lendingAsset.toLowerCase()];
  const cm = meta?.[o.collateralAsset.toLowerCase()];
  const ld = lm?.decimals ?? null;
  const cd = cm?.decimals ?? null;
  const lsym = lm?.symbol ?? shortAddress(o.lendingAsset);
  const csym = cm?.symbol ?? shortAddress(o.collateralAsset);
  const start: Required<EditInput> = {
    rateMin: formatBps(o.interestRateBps),
    rateMax: formatBps(o.interestRateBpsMax),
    amountMin: ld === null ? '' : unitsText(o.amount, ld),
    amountMax: ld === null ? '' : unitsText(o.amountMax, ld),
    collMin: cd === null ? '' : unitsText(o.collateralAmount, cd),
    collMax: cd === null ? '' : unitsText(o.collateralAmountMax, cd),
  };
  const value = (f: FieldName) => input[f] ?? start[f];
  const set = (f: FieldName, v: string) => setInput({ ...input, [f]: v });

  // Parse each shown field; a field not shown keeps the offer's figure.
  const errors: Partial<Record<FieldName, string>> = {};
  const rate = (f: FieldName): bigint | null => {
    const r = parseRate(value(f));
    if (typeof r === 'bigint') return r;
    errors[f] = text(r === 'empty' ? 'offerEdit.rateEmpty' : 'request.errInvalid');
    return null;
  };
  const amount = (f: FieldName, decimals: number | null, symbol: string): bigint | null => {
    if (decimals === null) {
      errors[f] = text('offerEdit.decimalsUnread');
      return null;
    }
    const r = parseAmount(value(f), decimals);
    if (r.ok) return r.value;
    errors[f] =
      r.error === 'empty' || r.error === 'zero'
        ? text('offerEdit.amountEmpty')
        : r.error === 'invalid'
          ? text('request.errInvalid')
          : format('request.errDecimals', { symbol, decimals: String(decimals) });
    return null;
  };
  const rMin = rate('rateMin');
  const rMax = rate('rateMax');
  const aMin = shape.amount ? amount('amountMin', ld, lsym) : o.amount;
  const aMax = shape.amount ? (shape.amountRange ? amount('amountMax', ld, lsym) : aMin) : o.amountMax;
  const cMin = shape.collateral ? amount('collMin', cd, csym) : o.collateralAmount;
  const cMax = shape.collateral ? (shape.collateralRange ? amount('collMax', cd, csym) : cMin) : o.collateralAmountMax;
  const next: EditTerms | null =
    rMin === null || rMax === null || aMin === null || aMax === null || cMin === null || cMax === null
      ? null
      : { amount: aMin, amountMax: aMax, interestRateBps: rMin, interestRateBpsMax: rMax, collateralAmount: cMin, collateralAmountMax: cMax };
  const problems = next === null ? [] : termsProblems(o, next);
  const shownProblems = problems.filter((p) => p !== 'unchanged' || asked);
  const ready = next !== null && problems.length === 0;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setAsked(true);
    if (ready && next) onChosen(next);
  };

  const field = (f: FieldName, labelKey: CopyKey, vars: Record<string, string> = {}) => (
    <FormField label={format(labelKey, vars)} error={asked || input[f] !== undefined ? (errors[f] ?? null) : null}>
      {({ id, describedBy, invalid }) => (
        <input
          id={id}
          inputMode="decimal"
          autoComplete="off"
          aria-describedby={describedBy}
          aria-invalid={invalid}
          value={value(f)}
          onChange={(e) => set(f, e.target.value)}
          data-testid={`offer-edit-${f}`}
        />
      )}
    </FormField>
  );

  return (
    <form className="partial-form" onSubmit={submit} noValidate data-testid="offer-edit-form">
      <h3>{text('offerEdit.formTitle')}</h3>
      <p className="tier-b">{text(lend ? 'offerEdit.leadLend' : 'offerEdit.leadBorrow')}</p>
      {field('rateMin', 'offerEdit.rateMinLabel')}
      {field('rateMax', 'offerEdit.rateMaxLabel')}
      {shape.amount && field('amountMin', shape.amountRange ? 'offerEdit.amountMinLabel' : 'offerEdit.amountLabel', { symbol: lsym })}
      {shape.amountRange && field('amountMax', 'offerEdit.amountMaxLabel', { symbol: lsym })}
      {shape.amount && !shape.amountRange && <p className="tier-b">{text('offerEdit.amountOneNote')}</p>}
      {shape.collateral && field('collMin', shape.collateralRange ? 'offerEdit.collMinLabel' : 'offerEdit.collLabel', { symbol: csym })}
      {shape.collateralRange && field('collMax', 'offerEdit.collMaxLabel', { symbol: csym })}
      {!shape.amount && <p className="tier-b">{text('offerEdit.refinanceNote')}</p>}
      <p className="tier-b">{format('offerEdit.termNote', { days: o.durationDays.toString() })}</p>
      {shownProblems.map((p) => (
        <p key={p} className="tier-a notice-warn" data-testid={`offer-edit-problem-${p}`}>
          {problemText(p, copy)}
        </p>
      ))}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" data-testid="offer-edit-review">
          {text('offerEdit.review')}
        </button>
        <button type="button" className="btn" onClick={() => (setInput(null), onClose())} data-testid="offer-edit-cancel">
          {text('flow.cancel')}
        </button>
      </div>
    </form>
  );
}

/** The review and the transaction, for one chosen set of figures. */
function EditFlow({ id, chain, own, meta, terms, onChangeTerms, onClose }: EditOfferProps & { terms: EditTerms | null; onChangeTerms: () => void }) {
  const copy = useCopy();
  const { text, format } = copy;
  const config = useConfig();
  const diamond = chain.diamondAddress as Hex;
  const account = own.account;
  const identity = reviewIdentity(own);
  const flowKey = editOfferKey(id);
  const [review, setReview] = useStoredValue<EditReview>(`${flowKey}:review`);
  const [, setInput] = useStoredValue<EditInput>(`${flowKey}:input`);
  const [loadError, setLoadError] = useState<string | null>(null);
  const setStep = useTxNote(flowKey);
  /** The approval this flow made and has not yet seen used or put back. */
  const approvalLeft = useRef<{ token: Hex; prior: bigint; amount: bigint; since: bigint | null } | null>(null);
  const exact = (asset: Hex, v: bigint) => exactTokenAmount(v, asset, meta, format);
  const words: AmountWords = (asset, v, x) => tokenAmount(v, asset, meta, format, x);
  const { readAllowance, allowanceIo, approveExactly, putBack } = approvalFlow({ own, config, chainId: chain.chainId, diamond, copy, exactAmount: exact, setStep });

  const tx = useTrackedTx({
    key: flowKey,
    chainId: chain.chainId,
    account,
    sources: own.sources,
    send: async () => {
      if (!review) throw new Error('no change under review');
      const r = review;
      const total = editPromptCount(r);
      let n = 0;
      const say = (what: string) => setStep(format('accept.stepOf', { n: String(++n), total: String(total), what }));
      approvalLeft.current = null;
      let approved = false;
      let prior = 0n;
      let since: bigint | null = null;
      const pull = r.move?.kind === 'pull' ? r.move : null;
      if (pull) {
        const asset = pull.asset;
        const io = allowanceIo(asset, (v, i, of) => say(of === 2 && i === 0 ? text('approval.stepZero') : format('offerEdit.stepApprove', { amount: exact(asset, v) })));
        // Read again now: it is what a stop puts back and what the review stated.
        prior = await readAllowance(asset);
        if (prior !== r.allowance) throw allowanceMoved(copy);
        const steps = prior >= pull.amount ? [] : await allowanceSteps(io, prior, pull.amount);
        if (steps.length !== r.approvalSteps) throw allowanceMoved(copy);
        if (steps.length > 0) {
          since = await approveExactly(io, asset, pull.amount, prior);
          approved = true;
          approvalLeft.current = { token: asset, prior, amount: pull.amount, since };
        }
      }
      const stop = async (reason: string): Promise<never> => {
        if (!approved || !pull) throw new StatedRefusal({ code: 'OfferEditStopped', reason, reopensAt: null, remedy: null });
        approvalLeft.current = null;
        const after = await putBack(pull.asset, prior, pull.amount, since);
        throw new StatedRefusal({ code: 'OfferEditStopped', reason: `${reason} ${after.sentence}`, reopensAt: null, remedy: null });
      };
      // The protocol's own verdict on this change, now.
      const dry = await askThrough(own, async (c) =>
        c.simulateContract({ address: diamond, abi: OFFER_MUTATE, functionName: 'modifyOffer', args: await modifyArgs(c, id, r.terms), account }),
      );
      if (dry.kind === 'reverted') return stop(format('offerEdit.dryRunRefused', { reason: refusalFromError(dry.error).reason }));
      if (dry.kind === 'unreadable') return stop(format('flow.unreadable', { reason: dry.reason }));
      say(text('offerEdit.stepSend'));
      try {
        const args = await own.read((c) => modifyArgs(c, id, r.terms)).then((x) => x.value);
        return await sendWrite(config, { address: diamond, abi: OFFER_MUTATE, functionName: 'modifyOffer', args, chainId: chain.chainId, account });
      } catch (e) {
        return stop(format('repay.stoppedAfterApproval', { reason: refusalFromError(e).reason }));
      }
    },
    // A sent change that did not take effect used none of the approval.
    unwind: async () => {
      const left = approvalLeft.current;
      approvalLeft.current = null;
      if (!left) return null;
      const after = await putBack(left.token, left.prior, left.amount, left.since);
      return cleanUpLeg(after, format('approval.legBack', { amount: allowanceFigure(left.prior, left.token, meta, copy) }));
    },
    measure: async (receipt) => {
      // A change that took effect used the whole approval it made.
      approvalLeft.current = null;
      return review ? measureEdit(review, receipt.logs, diamond, account, words, copy) : [];
    },
    release: async () => null,
  });

  const mounted = useMounted();
  const read = (t: EditTerms, who: string) => readEditReview(own, diamond, id, t, who, copy);
  const load = async () => {
    if (!terms) return;
    try {
      const next = await read(terms, identity);
      if (!mounted.current) return;
      setLoadError(null);
      setReview(next);
    } catch (e) {
      setLoadError(refusalFromError(e).reason);
    }
  };

  const same = (a: EditTerms, b: EditTerms) =>
    a.amount === b.amount &&
    a.amountMax === b.amountMax &&
    a.interestRateBps === b.interestRateBps &&
    a.interestRateBpsMax === b.interestRateBpsMax &&
    a.collateralAmount === b.collateralAmount &&
    a.collateralAmountMax === b.collateralAmountMax;

  // RB-RAILS: read again each block while the review is on screen.
  const onReview = tx.phase.kind === 'review' && review !== null && review.offerId === id && terms !== null && same(review.terms, terms);
  useReviewRefresh<EditReview>({
    chainId: chain.chainId,
    active: onReview,
    review,
    read: (before) => read(before.terms, before.identity),
    sameSubject: (a, b) => a.offerId === b.offerId && same(a.terms, b.terms),
    changed: (before, next) => editChanged(before, next, copy) !== null,
    setReview,
    onChanged: () => undefined,
  });

  const reviewOpened = useRef(false);
  const termsKey =
    terms === null ? '' : [terms.amount, terms.amountMax, terms.interestRateBps, terms.interestRateBpsMax, terms.collateralAmount, terms.collateralAmountMax].join(',');
  useEffect(() => {
    const open = tx.phase.kind === 'idle' || tx.phase.kind === 'review';
    if (!open || terms === null) return;
    if (tx.phase.kind === 'idle' && !reviewOpened.current) {
      reviewOpened.current = true;
      tx.review();
    }
    if (review === null || review.offerId !== id || !same(review.terms, terms) || review.identity !== identity) {
      setReview(null);
      let live = true;
      read(terms, identity).then(
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
    // Opened once per offer and figures; the tracker and the stored review
    // carry the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, termsKey]);

  const short = (r: EditReview) => (v: bigint) =>
    format('offerEdit.short', { amount: r.move && r.move.kind !== 'none' ? tokenAmount(v, r.move.asset, meta, format) : v.toString() });

  const recheck = async (current: () => boolean): Promise<Recheck> => {
    if (!review) return { kind: 'unreadable', reason: text('flow.reading') };
    let next: EditReview;
    try {
      next = await read(review.terms, review.identity);
    } catch (e) {
      return { kind: 'unreadable', reason: refusalFromError(e).reason };
    }
    const what = editChanged(review, next, copy);
    if (current()) setReview(next);
    if (what !== null) return { kind: 'changed', what };
    const blockers = editBlockers(next, account, copy, short(next));
    if (blockers.length > 0)
      return {
        kind: 'refused',
        refusal: { code: next.dryRun !== null && typeof next.dryRun !== 'string' ? next.dryRun.code : 'OfferEditBlocked', reason: blockers[0]!, reopensAt: null, remedy: null },
      };
    return { kind: 'ok' };
  };

  const changeTerms = () => {
    tx.reset();
    setReview(null);
    setStep(null);
    onChangeTerms();
  };

  const blockers = review ? editBlockers(review, account, copy, short(review)) : [];
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
            <WhyLink summaryKey="offerEdit.whySummary" detailKey="offerEdit.why" />
            <button type="button" className="btn btn-link" onClick={changeTerms} data-testid="offer-edit-change">
              {text('offerEdit.changeFigures')}
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
    <div className="repay-loan" data-testid="offer-edit-panel">
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
        receipt={review ? editReceipt(review, words, copy) : null}
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
