import { useEffect, useRef, useState } from 'react';
import { useConfig } from 'wagmi';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { useMode } from '../../app/ModeContext';
import { useCopy } from '../copy/useCopy';
import { formatBps } from '../ui/format';
import { refusalFromData, refusalFromError, StatedRefusal } from '../eligibility/refusal';
import { GUIDE_ORIGIN, guideUrl } from '../help/guide';
import { assetName, exactTokenAmount, tokenAmount, type TokenMetaMap } from '../reads/tokens';
import { erc20Pair, type RiskNeed } from '../risk/riskAccess';
import { RiskGate, RiskStepFlow } from '../risk/RiskAccessStep';
import { readTerms, termsUrl, type TermsState } from '../terms/terms';
import { allowanceSteps } from '../tx/approval';
import { allowanceMoved, approvalFlow } from '../tx/approvalFlow';
import { cleanUpLeg } from '../tx/cleanUp';
import { readValidUntil } from '../tx/deadline';
import type { LegOutcome } from '../tx/outcome';
import { sendWrite } from '../tx/send';
import { askAfter } from '../tx/simulate';
import { useStoredValue, useTxNote } from '../tx/txStore';
import { useMounted, useReviewRefresh } from '../tx/useReviewRefresh';
import { useTrackedTx } from '../tx/useTrackedTx';
import { ActionFlow, reviewIdentity, type Recheck } from '../ui/ActionFlow';
import { Notice } from '../ui/Notice';
import { pageHandoff } from '../../routes/pageMap';
import { borrowNowCall, borrowNowLogs, coverage, instantRequest, planFrom, planOf, restOf, type BorrowNowReview, type BorrowNowTerms, type SourceChoice, type SourceEstimate } from './borrowNow';
import { borrowNowBlocker, borrowNowReceipt } from './borrowNowReceipt';
import { borrowNowKey, readBorrowNowReview } from './borrowNowReview';
import { BORROW_NOW_KEY } from './BorrowNowForm';

type Hex = `0x${string}`;

/** What was not borrowed, once a borrow has landed, for the request that
 *  asks for exactly that. */
export interface BorrowNowRest {
  terms: BorrowNowTerms;
  amount: bigint;
  collateral: bigint;
}

interface BorrowNowFlowProps {
  terms: BorrowNowTerms;
  chain: SupportedChain;
  own: OwnStateClient;
  meta: TokenMetaMap | null;
  termsState: TermsState | null;
  /** Back to the form to change a figure (the typed form is kept). */
  onEdit: () => void;
  /** Post a request instead: for all of it, or, after a part was borrowed,
   *  for exactly the rest. */
  onRequest: (rest: BorrowNowRest) => void;
  /** Finished or abandoned; `done` when a borrow landed. */
  onClose: (done: boolean) => void;
}

/**
 * #3761 — "Borrow now". The review is `borrowInstant` asked of the protocol
 * from this wallet in this block, with every fill it opens. Signing asks it
 * again right before the prompt and sends the figure shown as the least the
 * transaction borrows, so it never borrows less. The collateral the wallet
 * supplies is approved for exactly that part, to the Diamond, and any of the
 * approval left unused is put back (best effort, stated either way). When
 * the lenders ready now cover part, the borrower may borrow that part and
 * then post a request for exactly the rest; when they cover none, the review
 * says nothing is borrowed now and offers the request.
 */
export function BorrowNowFlow({ terms, chain, own, meta, termsState, onEdit, onRequest, onClose }: BorrowNowFlowProps) {
  const copy = useCopy();
  const { text, format } = copy;
  const config = useConfig();
  const { mode } = useMode();
  const diamond = chain.diamondAddress;
  const account = own.account;
  const identity = reviewIdentity(own);
  // The connected identity as of the latest render, for the checks an async
  // step makes after its own awaits.
  const liveIdentity = useRef(identity);
  useEffect(() => {
    liveIdentity.current = identity;
  }, [identity]);
  const flowKey = BORROW_NOW_KEY;
  const [review, setReview] = useStoredValue<BorrowNowReview>(`${flowKey}:review`);
  const [consentFor, setConsentFor] = useStoredValue<number>(`${flowKey}:consent`);
  const [rest, setRest] = useStoredValue<BorrowNowRest>(`${flowKey}:rest`);
  const [riskOpen, setRiskOpen] = useStoredValue<RiskNeed>(`${flowKey}:risk`);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [approving, setApproving] = useState<string | null>(null);
  const setStep = useTxNote(flowKey);
  const approvalLeft = useRef<{ token: Hex; prior: bigint; amount: bigint; since: bigint | null } | null>(null);
  /** After a borrow that took effect: the approval it did not use (a
   *  partial borrow pulls only the collateral of its fills), to put back. */
  const leftover = useRef<{ token: Hex; prior: bigint; expect: bigint; since: bigint } | null>(null);
  const counter = useRef<{ n: number; total: number }>({ n: 0, total: 0 });

  const exact = (asset: Hex, v: bigint) => exactTokenAmount(v, asset, meta, format);
  const { readAllowance, allowanceIo, approveExactly, putBack } = approvalFlow({ own, config, chainId: chain.chainId, diamond, copy, exactAmount: exact, setStep });

  const tx = useTrackedTx({
    key: flowKey,
    chainId: chain.chainId,
    account,
    sources: own.sources,
    send: async () => {
      const r = review;
      const plan = r ? planOf(r) : null;
      if (!r || plan === null) throw new Error('no borrow under review');
      const t = r.terms;
      const token = t.collateral;
      counter.current = { n: 0, total: r.approvalSteps + 1 };
      const say = (what: string) => setStep(format('accept.stepOf', { n: String(++counter.current.n), total: String(counter.current.total), what }));
      approvalLeft.current = null;

      // 1. The approval of exactly the wallet's part, when needed, judged by
      //    the allowance each step leaves; read again first.
      let putItBack: (() => Promise<{ sentence: string }>) | null = null;
      let approvedAt: bigint | null = null;
      if (r.walletPart > 0n) {
        const io = allowanceIo(token, (amount, i, of) => say(of === 2 && i === 0 ? text('approval.stepZero') : format('borrowNow.stepApprove', { amount: exact(token, amount) })));
        const prior = await readAllowance(token);
        const steps = prior < r.walletPart ? await allowanceSteps(io, prior, r.walletPart) : [];
        if (steps.length !== r.approvalSteps) throw allowanceMoved(copy);
        if (steps.length > 0) {
          const since = await approveExactly(io, token, r.walletPart, prior);
          approvedAt = since;
          approvalLeft.current = { token, prior, amount: r.walletPart, since };
          putItBack = () => putBack(token, prior, r.walletPart, since);
        }
      } else if (r.approvalSteps !== 0) {
        throw allowanceMoved(copy);
      }
      const stop = async (reason: string): Promise<never> => {
        if (putItBack === null) throw new StatedRefusal({ code: 'BorrowStopped', reason, reopensAt: null, remedy: null });
        approvalLeft.current = null;
        const after = await putItBack();
        throw new StatedRefusal({ code: 'BorrowStopped', reason: `${reason} ${after.sentence}`, reopensAt: null, remedy: null });
      };

      // 2. Asked again right before signing, with the approval in place and
      //    the figure shown as the least it borrows.
      let call: ReturnType<typeof borrowNowCall>;
      let dry: Awaited<ReturnType<typeof askAfter>>;
      try {
        const deadline = await readValidUntil(own, 'borrowInstant');
        call = borrowNowCall(instantRequest(t, plan.total, deadline), r.sources);
        dry = await askAfter(own, approvedAt, (c, blockNumber) => c.simulateContract({ address: diamond, ...call, account, blockNumber }));
      } catch (e) {
        return stop(format('flow.unreadable', { reason: refusalFromError(e).reason }));
      }
      if (dry.kind === 'reverted') return stop(format('borrowNow.dryRunRefused', { reason: refusalFromError(dry.error).reason }));
      if (dry.kind === 'unreadable') return stop(format('flow.unreadable', { reason: dry.reason }));
      const now = planFrom((dry.value as { result: unknown }).result, r.sources);
      if (now.total < plan.total) return stop(format('borrowNow.dryRunLess', { now: exact(t.lending, now.total), shown: exact(t.lending, plan.total) }));

      // 3. The borrow, one transaction.
      say(text('borrowNow.stepSend'));
      try {
        return await sendWrite(config, { address: diamond, ...call, chainId: chain.chainId, account });
      } catch (e) {
        return stop(format('borrowNow.stoppedAfterApproval', { reason: refusalFromError(e).reason }));
      }
    },
    unwind: async () => {
      const left = approvalLeft.current;
      approvalLeft.current = null;
      if (!left) return null;
      const after = await putBack(left.token, left.prior, left.amount, left.since);
      return cleanUpLeg(after, format('approval.legBack', { amount: exact(left.token, left.prior) }));
    },
    measure: async (receipt, at) => {
      if (!review) return [];
      const t = review.terms;
      const plan = planOf(review);
      const legs: LegOutcome[] = [];
      const logs = borrowNowLogs(receipt.logs, diamond, account);
      // The approval covered the whole wallet part; what the fills drew from
      // the wallet is the transaction's own figure, and the rest is put back.
      const left = approvalLeft.current;
      approvalLeft.current = null;
      if (left && logs !== null && logs.fromWallet <= left.amount) leftover.current = { token: left.token, prior: left.prior, expect: left.amount - logs.fromWallet, since: at.blockNumber };
      if (logs === null) {
        legs.push({ status: 'unknown', label: text('borrowNow.legNotBorrowed'), reason: text('borrowNow.legUnread') });
        return legs;
      }
      const label = format('borrowNow.legBorrowed', { amount: tokenAmount(logs.total, t.lending, meta, format), count: String(logs.loans.length) });
      if (logs.total === 0n) legs.push({ status: 'not-done', label: text('borrowNow.legNotBorrowed'), reason: text('borrowNow.legNotBorrowed') });
      else if (plan !== null && logs.total < plan.total)
        legs.push({ status: 'not-done', label, reason: format('borrowNow.legOther', { amount: exact(t.lending, logs.total), expected: exact(t.lending, plan.total) }) });
      else legs.push({ status: 'done', label });
      // What was not borrowed, from the transaction's own record, for a
      // request for exactly that.
      if (logs.total < t.amount) {
        const left = restOf(t, { fills: [], total: logs.total, collateralLocked: logs.collateralLocked });
        setRest({ terms: t, amount: left.amount, collateral: left.collateral });
      }
      return legs;
    },
    release: async () => {
      const left = leftover.current;
      leftover.current = null;
      if (!left) return null;
      const after = await putBack(left.token, left.prior, left.expect, left.since);
      return cleanUpLeg(after, format('approval.legBack', { amount: exact(left.token, left.prior) }));
    },
  });

  const mounted = useMounted();
  const load = async () => {
    try {
      const next = await readBorrowNowReview(own, diamond, terms, identity);
      if (!mounted.current) return;
      setLoadError(null);
      setReview(next);
    } catch (e) {
      setLoadError(refusalFromError(e).reason);
    }
  };

  // RB-RAILS: read again each block while the review is on screen.
  const onReview = tx.phase.kind === 'review' && review !== null && review.terms === terms;
  useReviewRefresh<BorrowNowReview>({
    chainId: chain.chainId,
    active: onReview,
    review,
    read: (before) => readBorrowNowReview(own, diamond, before.terms, before.identity),
    sameSubject: (a, b) => a.terms === b.terms,
    changed: (before, next) => borrowNowKey(before) !== borrowNowKey(next),
    setReview,
    onChanged: () => setConsentFor(null),
  });

  // Open the review for these terms when the panel opens on them.
  const opened = useRef<BorrowNowTerms | null>(null);
  useEffect(() => {
    const open = tx.phase.kind === 'idle' || tx.phase.kind === 'review';
    if (!open) return;
    if (tx.phase.kind === 'idle' && opened.current !== terms) {
      opened.current = terms;
      tx.review();
    }
    if (review === null || review.terms !== terms) {
      setReview(null);
      setConsentFor(null);
      setRest(null);
      setRiskOpen(null);
      let live = true;
      readBorrowNowReview(own, diamond, terms, identity).then(
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terms]);

  const plan = review ? planOf(review) : null;
  const blocker = review ? borrowNowBlocker(review, meta, copy) : null;
  const cover = review ? coverage(plan, review.terms.amount) : 'none';

  const recheck = async (current: () => boolean): Promise<Recheck> => {
    if (!review) return { kind: 'unreadable', reason: text('flow.reading') };
    let next: BorrowNowReview;
    let nowTerms: TermsState;
    try {
      [next, nowTerms] = await Promise.all([
        readBorrowNowReview(own, diamond, review.terms, review.identity),
        own.read((c) => readTerms(c, diamond, account)).then((x) => x.value),
      ]);
    } catch (e) {
      return { kind: 'unreadable', reason: refusalFromError(e).reason };
    }
    if (nowTerms.kind === 'needed') return { kind: 'refused', refusal: { code: 'TermsNotAccepted', reason: text('lendOffer.termsNewer'), reopensAt: null, remedy: null } };
    if (borrowNowKey(review) !== borrowNowKey(next)) {
      if (current()) {
        setReview(next);
        setConsentFor(null);
      }
      return { kind: 'changed', what: text('borrowNow.changed') };
    }
    const b = borrowNowBlocker(next, meta, copy);
    if (b !== null) return { kind: 'refused', refusal: { code: 'BorrowBlocked', reason: b, reopensAt: null, remedy: null } };
    if (next.risk !== null) return { kind: 'refused', refusal: { code: 'RiskStepNeeded', reason: text('lend.rowRiskStep'), reopensAt: null, remedy: null } };
    return { kind: 'ok' };
  };

  // Where no figure can be read until the approval exists: approve exactly
  // the wallet's part on its own, then read the review again.
  const approveFirst = async () => {
    if (!review) return;
    // The approval is a write of its own, outside the flow's identity guard:
    // it is sent only for the wallet the review was read for.
    const reviewedFor = review.identity;
    if (liveIdentity.current !== reviewedFor) {
      clear();
      return;
    }
    const token = review.terms.collateral;
    setApproving(text('flow.reading'));
    try {
      const io = allowanceIo(token, (amount) => setApproving(format('borrowNow.stepApprove', { amount: exact(token, amount) })));
      const prior = await readAllowance(token);
      if (liveIdentity.current !== reviewedFor) {
        setApproving(null);
        clear();
        return;
      }
      if (prior < review.walletPart) await approveExactly(io, token, review.walletPart, prior);
      setApproving(null);
      await load();
    } catch (e) {
      setApproving(null);
      setLoadError(refusalFromError(e).reason);
    }
  };

  const clear = () => {
    setReview(null);
    setConsentFor(null);
    setStep(null);
    setRiskOpen(null);
  };
  const close = () => {
    const landed = tx.phase.kind === 'measured';
    clear();
    setRest(null);
    onClose(landed);
  };
  const edit = () => {
    tx.reset();
    clear();
    onEdit();
  };
  const requestAll = () => {
    tx.reset();
    clear();
    onRequest({ terms, amount: terms.amount, collateral: terms.collateralOffered });
  };

  const positions = pageHandoff('/positions');
  const consented = review !== null && consentFor === review.readAt;
  const termsLink = termsState && termsState.kind !== 'none' ? termsUrl(termsState.version) : `${GUIDE_ORIGIN}/terms`;
  const riskLink = guideUrl(mode, 'borrow-start');
  const pairLabel = format('risk.pairName', { lend: assetName(terms.lending, meta), coll: assetName(terms.collateral, meta) });
  const riskPair = erc20Pair(terms.lending, terms.collateral);
  const onReviewPhase = tx.phase.kind === 'review';

  const gate = review
    ? {
        ready: consented && blocker === null && review.risk === null,
        node: (
          <div className="accept-gate">
            <SourceChoiceLines choice={review.choice} />
            {blocker !== null && (
              <Notice tone={review.state.kind === 'needs-approval' ? 'warn' : 'danger'} tier="A">
                {blocker}
              </Notice>
            )}
            {review.state.kind === 'needs-approval' && review.state.preview !== null && (
              <div data-testid="borrownow-preview" data-total={review.state.preview.plan.total.toString()}>
                <p className="tier-a">
                  {format('borrowNow.previewGives', {
                    amount: tokenAmount(review.state.preview.plan.total, terms.lending, meta, format),
                    count: String(review.state.preview.plan.fills.length),
                  })}
                </p>
                {review.state.preview.skipped.map((k, n) => (
                  <p key={n} className="tier-b">
                    {format('borrowNow.previewSkipped', { reason: refusalFromData(k.reason, 0n).reason })}
                  </p>
                ))}
                <p className="tier-b">{text('borrowNow.previewNotBinding')}</p>
              </div>
            )}
            {review.state.kind === 'needs-approval' && onReviewPhase && (
              <p>
                <button type="button" className="btn btn-primary" disabled={approving !== null} onClick={() => void approveFirst()} data-testid="borrownow-approve-first">
                  {format('borrowNow.stepApprove', { amount: exact(review.terms.collateral, review.walletPart) })}
                </button>
                {approving !== null && <span className="tier-b"> {approving}</span>}
              </p>
            )}
            {plan !== null && (
              <p className="tier-a" data-testid="borrownow-cover" data-cover={cover}>
                {cover === 'all'
                  ? text('borrowNow.coverAll')
                  : format('borrowNow.coverPart', { part: tokenAmount(plan.total, terms.lending, meta, format), amount: tokenAmount(terms.amount, terms.lending, meta, format) })}
                {cover === 'part' && ` ${text('borrowNow.restLater')}`}
              </p>
            )}
            {review.risk !== null && (
              <RiskGate chain={chain} own={own} need={review.risk} source={{ kind: 'pair', pair: riskPair }} pairLabel={pairLabel} onOpen={() => setRiskOpen(review.risk)} />
            )}
            {blocker === null && (
              <p className="consent tier-a">
                <label>
                  <input type="checkbox" checked={consented} onChange={(e) => setConsentFor(e.target.checked ? review.readAt : null)} data-testid="borrownow-consent" />
                  <span>
                    {text('accept.consentLead')}
                    <a href={riskLink} target="_blank" rel="noreferrer">
                      {text('accept.consentRisk')}
                    </a>
                    {text('accept.consentAnd')}
                    <a href={termsLink} target="_blank" rel="noreferrer">
                      {text('accept.consentTerms')}
                    </a>
                    {text('accept.consentEnd')}
                  </span>
                </label>
              </p>
            )}
            {blocker === null && !consented && <p className="tier-b">{text('accept.consentNeeded')}</p>}
            {onReviewPhase && (
              <p className="actions">
                {(cover !== 'all' || review.state.kind === 'market-off' || review.state.kind === 'no-source' || review.state.kind === 'none-found') && review.state.kind !== 'needs-approval' && (
                  <button type="button" className="btn" onClick={requestAll} data-testid="borrownow-request-all">
                    {text(plan === null ? 'borrowNow.chooseRequest' : 'borrowNow.chooseAll')}
                  </button>
                )}
                <button type="button" className="btn btn-link" onClick={edit} data-testid="borrownow-edit">
                  {text('autoLend.edit')}
                </button>
              </p>
            )}
          </div>
        ),
      }
    : undefined;

  const describeAsset = (a: Hex) => {
    const m = meta?.[a.toLowerCase()];
    return m && m.decimals !== null ? { symbol: m.symbol ?? a, decimals: m.decimals } : null;
  };

  return (
    <div className="post-request borrownow-flow" data-testid="borrownow-flow">
      {loadError !== null && (
        <Notice tone="warn" tier="A">
          {format('flow.unreadable', { reason: loadError })}{' '}
          <button type="button" className="btn" onClick={() => void load()}>
            {text('consent.retry')}
          </button>
        </Notice>
      )}
      {riskOpen !== null ? (
        <RiskStepFlow
          chain={chain}
          own={own}
          need={riskOpen}
          source={{ kind: 'pair', pair: riskPair }}
          pairLabel={pairLabel}
          flowKey={flowKey}
          onBack={() => {
            setRiskOpen(null);
            void load();
          }}
        />
      ) : (
        <ActionFlow
          tx={tx}
          identity={identity}
          reviewedFor={review?.identity ?? tx.frozen?.identity ?? identity}
          publicQueue
          receipt={review ? borrowNowReceipt(review, diamond, meta, copy) : null}
          recheck={recheck}
          describeAsset={describeAsset}
          explorer={chain.blockExplorer}
          next={
            positions.kind === 'none'
              ? null
              : positions.kind === 'here'
                ? { label: text('borrowNow.openPositions'), to: positions.to }
                : { label: text('borrowNow.openPositions'), href: positions.href }
          }
          gate={gate}
          onClose={close}
        />
      )}
      {rest !== null && rest.amount > 0n && tx.phase.kind === 'measured' && (
        <section className="borrownow-rest" aria-labelledby="borrownow-rest-title" data-testid="borrownow-rest">
          <h3 id="borrownow-rest-title">{text('borrowNow.restTitle')}</h3>
          <p className="tier-a">{format('borrowNow.restLead', { amount: exactTokenAmount(rest.amount, rest.terms.lending, meta, format) })}</p>
          <p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                const r = rest;
                clear();
                setRest(null);
                tx.reset();
                onRequest(r);
              }}
              data-testid="borrownow-rest-go"
            >
              {text('borrowNow.restGo')}
            </button>
          </p>
        </section>
      )}
    </div>
  );
}

/** BorrowingDesign §12: how many lenders the chosen list uses and the rate
 *  across them, beside what the other order would change. Estimated from
 *  the read, and said so; the plan above is the protocol's own answer. */
function SourceChoiceLines({ choice }: { choice: SourceChoice | undefined }) {
  const { text, format } = useCopy();
  if (!choice) return null;
  const line = (e: SourceEstimate) => ({ lenders: String(e.lenders), low: formatBps(e.lowBps), high: formatBps(e.highBps), across: formatBps(e.acrossBps) });
  const other = choice.other;
  return (
    <div data-testid="borrownow-choice" data-order={choice.order.kind} data-lenders={choice.chosen?.lenders ?? 0}>
      <p className="tier-b">{choice.chosen ? format('borrowNow.choiceChosen', line(choice.chosen)) : text('borrowNow.choiceNone')}</p>
      {other.estimate && (
        <p className="tier-b" data-testid="borrownow-choice-other">
          {other.order.kind === 'fewest-lenders'
            ? format('borrowNow.choiceOtherFewest', { ...line(other.estimate), spread: formatBps(other.order.spreadBps) })
            : format('borrowNow.choiceOtherBest', line(other.estimate))}
        </p>
      )}
      <p className="tier-b">{text('borrowNow.choiceEstimate')}</p>
    </div>
  );
}
