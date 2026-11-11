import { useEffect, useRef, useState } from 'react';
import type { Abi, Log } from 'viem';
import { Link } from 'react-router-dom';
import { useConfig } from 'wagmi';
import { signTypedData } from 'wagmi/actions';
import { sendWrite } from '../tx/send';
import { OfferAcceptFacetABI } from '@vaipakam/contracts/abis';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { useCopy } from '../copy/useCopy';
import { refusalFromError, StatedRefusal } from '../eligibility/refusal';
import { WhyLink } from '../help/WhyLink';
import { GUIDE_ORIGIN, guideUrl } from '../help/guide';
import { useMode } from '../../app/ModeContext';
import { ACCEPT_DEADLINE_SECONDS, ACCEPT_TERMS_DOMAIN_NAME, ACCEPT_TERMS_DOMAIN_VERSION, ACCEPT_TERMS_TYPES, buildAcceptTerms, freshNonce } from '../offers/acceptTerms';
import { deliverySplit, legVerdict, moved, openedLoan } from '../offers/acceptOutcome';
import { acceptFigures, lenderFigures } from '../offers/model';
import { readVault } from '../offers/reads';
import { exactTokenAmount, tokenAmount, type TokenMetaMap } from '../reads/tokens';
import { readTerms, termsUrl, type TermsState } from '../terms/terms';
import { askThrough } from '../tx/simulate';
import { cleanUpLeg } from '../tx/cleanUp';
import { useStoredValue, useTxNote } from '../tx/txStore';
import { useMounted, useReviewRefresh } from '../tx/useReviewRefresh';
import { useTrackedTx } from '../tx/useTrackedTx';
import type { AnchoredReader } from '../tx/anchored';
import { allowanceSteps } from '../tx/approval';
import { allowanceMoved, approvalFlow } from '../tx/approvalFlow';
import type { LegOutcome } from '../tx/outcome';
import { ActionFlow, reviewIdentity, type Recheck } from '../ui/ActionFlow';
import { Notice } from '../ui/Notice';
import { shortAddress } from '../ui/format';
import { erc20Pair, needFromAcceptCode, needFromRefusal, type PairSource, type RiskNeed } from '../risk/riskAccess';
import { signedFillCall, signedFillFrom } from '../desk/signedFill';
import { sourceKey, type AcceptSource } from './acceptSource';
import { RiskGate, RiskStepFlow } from '../risk/RiskAccessStep';
import { changedBetween, paid, promptCount, readAcceptReview, reviewBlockers, type AcceptReview } from './acceptReview';
import { indexerPositionFlowReader } from '../offers/positionFlow';
import { useWorldRail } from '../reads/world/WorldRailContext';
import { acceptReceipt } from './receipt';

type Hex = `0x${string}`;

const ACCEPT_ABI = OfferAcceptFacetABI as Abi;

/** The store keys each page's acceptance keeps its state under, so a
 *  navigation or a wallet switch that unmounts the panel never drops a
 *  review, a consent or a transaction's hash (the tracker itself is under
 *  the key). Each page has its own, so an acceptance in flight on one page
 *  never shows on the other. */
export const ACCEPT_KEY = 'borrow.accept';
export const LEND_ACCEPT_KEY = 'lend.accept';

interface AcceptOfferProps {
  /** The page's store key (ACCEPT_KEY or LEND_ACCEPT_KEY). */
  flowKey: string;
  /** What is taken: a stored offer by its id, or a maker's signed order. */
  source: AcceptSource;
  chain: SupportedChain;
  own: OwnStateClient;
  meta: TokenMetaMap | null;
  terms: TermsState | null;
  onClose: () => void;
}

/**
 * OFF-50 — an offer taken whole: a borrower takes a lender's offer, or a
 * lender funds a borrow request; the side is the offer's own (the review's
 * `role`). The review is built from the protocol's own preview for this
 * wallet and the offer as stored; the single Risk and Terms consent is
 * bound to the figures shown (a re-read that moves any of them clears it);
 * the wallet is asked to sign the exact terms, then to approve exactly what
 * it pays when needed (the collateral, or the amount lent), and the
 * acceptance is sent only after a dry run with that signature passes. If
 * anything stops it after an approval, the approval is put back (best
 * effort, stated either way). The outcome is measured from the
 * transaction's own logs: the loan it opened, and for a borrower what
 * arrived in the wallet and what moved into the vault, for a lender what
 * left the wallet and the fee share that came back.
 */
export function AcceptOffer({ flowKey, source, chain, own, meta, terms, onClose }: AcceptOfferProps) {
  const copy = useCopy();
  const { text, format } = copy;
  const config = useConfig();
  const { mode } = useMode();
  const diamond = chain.diamondAddress;
  const account = own.account;
  // #3205 — the indexer's moved verdict for a position-bound offer.
  const flows = indexerPositionFlowReader(useWorldRail().indexer, chain.chainId);
  const identity = reviewIdentity(own);
  /** The subject's key: a review read for one offer or order never lands
   *  on another's. */
  const subject = sourceKey(source);
  const [review, setReview] = useStoredValue<AcceptReview>(`${flowKey}:review`);
  /** The review read the consent was given against (its `readAt`): a new
   *  read is a new set of figures, so the consent does not carry over. */
  const [consentFor, setConsentFor] = useStoredValue<number>(`${flowKey}:consent`);
  const [loanId, setLoanId] = useStoredValue<bigint>(`${flowKey}:loan`);
  // Whether the loan's principal was credited to the vault: the finish card
  // then offers the withdrawal beside the new loan.
  const [credited, setCredited] = useStoredValue<boolean>(`${flowKey}:credited`);
  /** The risk-access step open in the review's place, if any (ACC-RISK). */
  const [riskOpen, setRiskOpen] = useStoredValue<RiskNeed>(`${flowKey}:risk`);
  /** OFF-60 — a signed order has no risk-access preview yet (#3577): the
   *  step a dry run's refusal named, offered when the review shows again. */
  const [dryRisk, setDryRisk] = useStoredValue<RiskNeed>(`${flowKey}:dryRisk`);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** The wallet step open now, kept with the tracker (it outlives the page). */
  const setStep = useTxNote(flowKey);
  /** The approval this flow made and has not yet seen used or put back: a
   *  submitted acceptance that reverts leaves it standing, so the receipt's
   *  measurement puts it back. A ref, because the measurement runs from the
   *  closure the tracker froze at submission. `since` is the block the
   *  approval mined in, so a put-back never reads it as it stood before. */
  const approvalLeft = useRef<{ token: Hex; prior: bigint; amount: bigint; since: bigint | null } | null>(null);

  const amt = (asset: Hex, v: bigint) => tokenAmount(v, asset, meta, format);
  // Every digit: what an approval is sent for, and the two figures a
  // measured-outcome mismatch compares (shortened, both could read the same).
  const exact = (asset: Hex, v: bigint) => exactTokenAmount(v, asset, meta, format);
  const { readAllowance, allowanceIo, approveExactly, putBack } = approvalFlow({ own, config, chainId: chain.chainId, diamond, copy, exactAmount: exact, setStep });

  const tx = useTrackedTx({
    key: flowKey,
    chainId: chain.chainId,
    account,
    sources: own.sources,
    send: async () => {
      if (!review) throw new Error('no acceptance under review');
      const r = review;
      const total = promptCount(r);
      let n = 0;
      const say = (what: string) =>
        setStep(
          format('accept.stepOf', {
            n: String(++n),
            total: String(total),
            what,
          }),
        );
      // What the wallet pays: the collateral, or the amount lent.
      const { asset: collateral, amount: lock } = paid(r);
      approvalLeft.current = null;

      // The allowance is read again now: the value a stop puts back is the
      // one the wallet holds right before this flow's approval, never the
      // review's, and a change that alters the steps stops before any prompt.
      const io = allowanceIo(collateral, (amount, i, of) => say(of === 2 && i === 0 ? text('approval.stepZero') : format('approval.step', { amount: exact(collateral, amount) })));
      const prior = await readAllowance(collateral);
      const steps = prior < lock ? await allowanceSteps(io, prior, lock) : [];
      const approved = steps.length > 0;
      if (steps.length !== r.approvalSteps) throw allowanceMoved(copy);

      // 1. The signed terms, built from the offer as stored. No chain effect.
      const block = await own.read((c) => c.getBlock({ blockTag: 'latest' }));
      const message = buildAcceptTerms(r.offer, {
        acceptor: account,
        linkedLoanId: r.linkedLoanId,
        riskTermsHash: r.riskTermsHash,
        nonce: freshNonce(),
        deadline: block.value.timestamp + BigInt(ACCEPT_DEADLINE_SECONDS),
        illiquidLending: r.lendingClass === 'illiquid',
        illiquidCollateral: r.collateralClass === 'illiquid',
        // A signed order's fill binds the terms to the order's hash.
        ...(r.source.kind === 'signed' ? { offerKey: r.source.order.orderHash } : {}),
      });
      say(text('accept.stepSign'));
      const signature = await signTypedData(config, {
        account,
        domain: {
          name: ACCEPT_TERMS_DOMAIN_NAME,
          version: ACCEPT_TERMS_DOMAIN_VERSION,
          chainId: chain.chainId,
          verifyingContract: diamond,
        },
        types: ACCEPT_TERMS_TYPES,
        primaryType: 'AcceptTerms',
        message,
      });

      // 2. The approval, for exactly what is locked, when the wallet's
      //    current allowance does not cover it.
      //    Each step is judged by the allowance it leaves (shared/tx/approval):
      //    a cancelled, replaced or unreadable step is never taken as done.
      let since: bigint | null = null;
      if (approved) {
        since = await approveExactly(io, collateral, lock, prior);
        approvalLeft.current = { token: collateral, prior, amount: lock, since };
      }

      // Anything that stops the acceptance after the approval puts it back.
      const stop = async (reason: string): Promise<never> => {
        if (!approved)
          throw new StatedRefusal({
            code: 'AcceptStopped',
            reason,
            reopensAt: null,
            remedy: null,
          });
        approvalLeft.current = null;
        const after = await putBack(collateral, prior, lock, since);
        throw new StatedRefusal({
          code: 'AcceptStopped',
          reason: `${reason} ${after.sentence}`,
          reopensAt: null,
          remedy: null,
        });
      };

      // The call: `acceptOffer` for a stored offer, `acceptSignedOffer` for
      // a signed order (the order, its maker's signature and these terms).
      const call =
        r.source.kind === 'stored'
          ? { abi: ACCEPT_ABI, functionName: 'acceptOffer' as const, args: [r.source.offerId, message, signature] as const }
          : signedFillCall(r.source.order, message, signature);

      // 3. The dry run with the real signature: the protocol's own verdict.
      const dry = await askThrough(own, (c) =>
        c.simulateContract({
          address: diamond,
          abi: call.abi,
          functionName: call.functionName,
          args: call.args,
          account,
        }),
      );
      if (dry.kind === 'reverted') {
        const refusal = refusalFromError(dry.error);
        // With no risk-access preview for a signed order, its refusal is the
        // first word on it: the step it names is offered on the review.
        if (!r.riskPreviewed) setDryRisk(needFromRefusal(refusal.code));
        return stop(format('accept.dryRunRefused', { reason: refusal.reason }));
      }
      if (dry.kind === 'unreadable') return stop(format('flow.unreadable', { reason: dry.reason }));

      // 4. The acceptance.
      say(text('accept.stepSend'));
      try {
        return await sendWrite(config, {
          address: diamond,
          abi: call.abi,
          functionName: call.functionName,
          args: call.args,
          chainId: chain.chainId,
          account,
        });
      } catch (e) {
        return stop(
          format('accept.stoppedAfterApproval', {
            reason: refusalFromError(e).reason,
          }),
        );
      }
    },
    // A sent acceptance that did not take effect (it reverted because
    // someone took the offer first, or the wallet cancelled or replaced it)
    // used none of the approval this flow made: the tracker runs this to put
    // it back, and the outcome says whether that happened.
    unwind: async () => {
      const left = approvalLeft.current;
      approvalLeft.current = null;
      if (!left) return null;
      const after = await putBack(left.token, left.prior, left.amount, left.since);
      return cleanUpLeg(after, format('approval.legBack', { amount: exact(left.token, left.prior) }));
    },
    measure: async (receipt, at) => {
      if (!review) return [];
      // The offer the acceptance took: a stored offer's own id, or the one a
      // signed order's fill wrote, from the fill's own log (null if none).
      const offerId = review.source.kind === 'stored' ? review.source.offerId : (signedFillFrom(receipt.logs, diamond, review.source.order.orderHash)?.offerId ?? null);
      return review.role === 'borrower' ? measureBorrower(review, offerId, receipt.logs, at) : measureLender(review, offerId, receipt.logs);
    },
  });

  /** A borrower's acceptance: the loan, the net principal credited to the
   *  vault, the fee share paid back, and the collateral locked in the vault. */
  const measureBorrower = async (r: AcceptReview, offerId: bigint | null, logs: readonly Log[], at: AnchoredReader): Promise<LegOutcome[]> => {
    const f = acceptFigures(r.preview, r.offer.durationDays, r.matcherBps);
    const legs: LegOutcome[] = [];
    const opened = offerId === null ? null : openedLoan(logs, diamond, offerId, account);
    legs.push(loanLeg(r, opened, 'accept.legLoan'));
    let vault: Hex | null = null;
    try {
      vault = await at.read((c, b) => readVault(c, diamond, account, b));
    } catch {
      vault = null;
    }
    // The net principal credited to the vault, the fee share paid back and
    // what else left the lender's vault must add up to the principal the
    // loan recorded, or the split is not substantiated. A figure other than
    // the preview's (the discount tier is read again as the loan opens) is
    // named beside it.
    const lending = r.offer.lendingAsset;
    const shownLabel = format('accept.legReceived', { amount: amt(lending, f.toVault) });
    const split = vault === null || offerId === null ? null : deliverySplit(logs, diamond, lending, account, vault, offerId);
    if (vault === null) {
      legs.push({ status: 'unknown', label: shownLabel, reason: text('accept.vaultUnknown') });
    } else if (split === null || split.credited === 0n) {
      legs.push({ status: 'not-done', label: shownLabel, reason: text('accept.receivedNone') });
    } else if (opened && split.credited + split.back + split.fee === opened.principal) {
      setCredited(true);
      legs.push({
        status: 'done',
        label:
          split.credited === f.toVault
            ? format('accept.legReceived', { amount: amt(lending, split.credited) })
            : format('accept.legReceivedFee', { amount: exact(lending, split.credited), shown: exact(lending, f.toVault), principal: exact(lending, opened.principal) }),
      });
    } else {
      legs.push({
        status: 'unknown',
        label: shownLabel,
        reason: format('accept.receivedOther', { amount: exact(lending, split.credited), expected: exact(lending, f.toVault) }),
      });
    }
    // The fee share paid to the sender: to the wallet, or into the vault
    // under protected mode (a vault that could not be read is not counted).
    const back = split?.back ?? moved(logs, lending, null, account);
    if (f.feeBack > 0n || back > 0n) {
      const backLabel = format('accept.legFeeBack', { amount: amt(lending, f.feeBack) });
      const bv = legVerdict(back, f.feeBack);
      legs.push(
        bv === 'done'
          ? { status: 'done', label: backLabel }
          : { status: bv, label: backLabel, reason: format('accept.feeBackOther', { amount: exact(lending, back), expected: exact(lending, f.feeBack) }) },
      );
    }
    const collateral = r.offer.collateralAsset;
    const lockLabel = format('accept.legLocked', {
      amount: amt(collateral, f.collateral),
    });
    if (vault === null) {
      legs.push({
        status: 'unknown',
        label: lockLabel,
        reason: text('accept.vaultUnknown'),
      });
    } else {
      const locked = moved(logs, collateral, account, vault);
      const lv = legVerdict(locked, f.collateral);
      legs.push(
        lv === 'done'
          ? { status: 'done', label: lockLabel }
          : {
              status: lv,
              label: lockLabel,
              reason: format('accept.lockedOther', {
                amount: exact(collateral, locked),
                expected: exact(collateral, f.collateral),
              }),
            },
      );
    }
    return legs;
  };

  /** A lender's acceptance: the loan (recorded for the request's creator as
   *  borrower), what left the wallet, and the fee share that came back. A
   *  fee share other than the preview's (the borrower's discount or Full
   *  tariff is settled as the loan opens) is named, never assumed. */
  const measureLender = (r: AcceptReview, offerId: bigint | null, logs: readonly Log[]): LegOutcome[] => {
    const f = lenderFigures(r.preview, r.offer.durationDays, r.matcherBps, 0n);
    const lending = r.offer.lendingAsset;
    const legs: LegOutcome[] = [loanLeg(r, offerId === null ? null : openedLoan(logs, diamond, offerId, r.offer.creator), 'lendAccept.legLoan')];
    const lent = moved(logs, lending, account, null);
    const lentLabel = format('lendAccept.legLent', { amount: amt(lending, f.principal) });
    const lv = legVerdict(lent, f.principal);
    legs.push(
      lv === 'done'
        ? { status: 'done', label: lentLabel }
        : {
            status: lv,
            label: lentLabel,
            reason: lv === 'not-done' ? text('lendAccept.lentNone') : format('lendAccept.lentOther', { amount: exact(lending, lent), expected: exact(lending, f.principal) }),
          },
    );
    const back = moved(logs, lending, null, account);
    if (f.feeBack > 0n || back > 0n) {
      const backLabel = format('lendAccept.legFeeBack', { amount: amt(lending, f.feeBack) });
      legs.push(
        back === f.feeBack
          ? { status: 'done', label: backLabel }
          : {
              status: back === 0n ? 'not-done' : 'unknown',
              label: backLabel,
              reason: format('lendAccept.feeBackOther', { amount: exact(lending, back), expected: exact(lending, f.feeBack) }),
            },
      );
    }
    return legs;
  };

  const loanLeg = (r: AcceptReview, opened: ReturnType<typeof openedLoan>, key: 'accept.legLoan' | 'lendAccept.legLoan'): LegOutcome => {
    if (opened) {
      setLoanId(opened.loanId);
      return { status: 'done', label: format(key, { id: opened.loanId.toString() }) };
    }
    if (r.source.kind === 'signed') return { status: 'not-done', label: text('signedFill.legNoLoan'), reason: text('signedFill.noLoan') };
    return { status: 'not-done', label: format('accept.legNoLoan', { id: r.source.offerId.toString() }), reason: text('accept.noLoan') };
  };

  const mounted = useMounted();
  const load = async () => {
    try {
      const next = await readAcceptReview(own, diamond, source, identity, flows);
      if (!mounted.current) return;
      setLoadError(null);
      setReview(next);
    } catch (e) {
      setLoadError(refusalFromError(e).reason);
    }
  };

  const reviewOpened = useRef<string | null>(null);

  // RB-RAILS: read again each block while the review is on screen; a late
  // answer never lands on another offer's review (useReviewRefresh).
  const onReview = tx.phase.kind === 'review' && review !== null && sourceKey(review.source) === subject;
  useReviewRefresh<AcceptReview>({
    chainId: chain.chainId,
    active: onReview,
    review,
    read: (before) => readAcceptReview(own, diamond, before.source, before.identity, flows),
    sameSubject: (a, b) => sourceKey(a.source) === sourceKey(b.source),
    changed: (before, next) => changedBetween(before, next, copy) !== null,
    setReview,
    onChanged: () => setConsentFor(null),
  });

  // Open the review for this offer when the panel opens on it: a review
  // kept for another offer (or none) is replaced; one in flight is kept.
  useEffect(() => {
    const open = tx.phase.kind === 'idle' || tx.phase.kind === 'review';
    if (!open) return;
    // Once per offer: a development double-run of this effect sees the
    // same (stale) idle phase and must not ask for the review twice.
    if (tx.phase.kind === 'idle' && reviewOpened.current !== subject) {
      reviewOpened.current = subject;
      tx.review();
    }
    if (review === null || sourceKey(review.source) !== subject) {
      setReview(null);
      setConsentFor(null);
      setLoanId(null);
      setRiskOpen(null);
      setDryRisk(null);
      let live = true;
      readAcceptReview(own, diamond, source, identity, flows).then(
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
    // Opened once per offer or order; the tracker and the stored review carry the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subject]);

  const recheck = async (current: () => boolean): Promise<Recheck> => {
    if (!review) return { kind: 'unreadable', reason: text('flow.reading') };
    let next: AcceptReview;
    let nowTerms: TermsState;
    try {
      // OFF-35 holds at the moment the wallet opens, not only when the flow
      // did: a Terms version published since the review is accepted first.
      [next, nowTerms] = await Promise.all([readAcceptReview(own, diamond, review.source, review.identity, flows), own.read((c) => readTerms(c, diamond, account)).then((r) => r.value)]);
    } catch (e) {
      return { kind: 'unreadable', reason: refusalFromError(e).reason };
    }
    if (nowTerms.kind === 'needed') return { kind: 'refused', refusal: { code: 'TermsNotAccepted', reason: text('accept.termsNewer'), reopensAt: null, remedy: null } };
    const what = changedBetween(review, next, copy);
    if (what !== null) {
      if (current()) {
        setReview(next);
        setConsentFor(null);
      }
      return { kind: 'changed', what };
    }
    const blockers = reviewBlockers(next, meta, copy);
    if (blockers.length > 0)
      return {
        kind: 'refused',
        refusal: {
          code: 'AcceptBlocked',
          reason: blockers[0]!,
          reopensAt: null,
          remedy: null,
        },
      };
    return { kind: 'ok' };
  };

  const blockers = review ? reviewBlockers(review, meta, copy) : [];
  const consented = review !== null && consentFor === review.readAt;
  const termsLink = terms && terms.kind !== 'none' ? termsUrl(terms.version) : `${GUIDE_ORIGIN}/terms`;
  const lender = review?.role === 'lender';
  const riskLink = guideUrl(mode, lender ? 'lend-risks' : 'borrow-risks');
  // A risk-access block this wallet can clear itself: never the lender's own
  // (the protocol answers the creator's block first), and the step is the one
  // the protocol's answer names.
  // For a signed order, which has no preview of the gate yet (#3577), it is
  // the step the last dry run's refusal named.
  const riskNeed = review === null ? null : !review.riskPreviewed ? dryRisk : review.creatorGate === 0 ? needFromAcceptCode(review.gate) : null;
  // The pair the step stands on: the protocol resolves a stored offer's; a
  // signed order's is its two ERC-20 legs, the only shape a fill takes.
  const riskSource: PairSource =
    source.kind === 'stored' ? { kind: 'offer', offerId: source.offerId } : { kind: 'pair', pair: erc20Pair(source.order.order.lendingAsset as Hex, source.order.order.collateralAsset as Hex) };
  const symbol = (a: Hex) => meta?.[a.toLowerCase()]?.symbol ?? shortAddress(a);
  const pairLabel = review ? format('risk.pairName', { lend: symbol(review.offer.lendingAsset), coll: symbol(review.offer.collateralAsset) }) : '';

  const gate = review
    ? {
        ready: consented && blockers.length === 0,
        node: (
          <div className="accept-gate">
            {blockers.map((b) => (
              <Notice key={b} tone="danger" tier="A">
                {b}
              </Notice>
            ))}
            {riskNeed !== null && (
              <RiskGate chain={chain} own={own} need={riskNeed} source={riskSource} pairLabel={pairLabel} onOpen={() => setRiskOpen(riskNeed)} />
            )}
            {review.consent === false && <p className="tier-b">{text(lender ? 'lendAccept.shareOff' : 'accept.feeOff')}</p>}
            <WhyLink summaryKey={lender ? 'lendAccept.feeSummary' : 'accept.feeSummary'} detailKey={lender ? 'lendAccept.feeWhy' : 'accept.feeWhy'} />
            <WhyLink summaryKey="accept.signSummary" detailKey={lender ? 'lendAccept.signWhy' : 'accept.signWhy'} />
            {blockers.length === 0 && (
              <p className="consent tier-a">
                <label>
                  <input type="checkbox" checked={consented} onChange={(e) => setConsentFor(e.target.checked ? review.readAt : null)} data-testid="accept-consent" />
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
            {blockers.length === 0 && !consented && <p className="tier-b">{text('accept.consentNeeded')}</p>}
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
    setConsentFor(null);
    setLoanId(null);
    setStep(null);
    setRiskOpen(null);
    setDryRisk(null);
    onClose();
  };

  return (
    <div
      className="accept-offer"
      data-offer-id={source.kind === 'stored' ? source.offerId.toString() : undefined}
      data-order-hash={source.kind === 'signed' ? source.order.orderHash : undefined}
    >
      {loadError !== null && (
        <Notice tone="warn" tier="A">
          {format('flow.unreadable', { reason: loadError })}{' '}
          <button type="button" className="btn" onClick={() => void load()}>
            {text('consent.retry')}
          </button>
        </Notice>
      )}
      {riskOpen !== null && review !== null ? (
        <RiskStepFlow
          chain={chain}
          own={own}
          need={riskOpen}
          source={riskSource}
          pairLabel={pairLabel}
          flowKey={flowKey}
          onBack={() => {
            setRiskOpen(null);
            setDryRisk(null);
            void load();
          }}
        />
      ) : (
        <ActionFlow
          tx={tx}
          publicQueue
          identity={identity}
          reviewedFor={review?.identity ?? tx.frozen?.identity ?? identity}
          receipt={review ? acceptReceipt(review, meta, copy) : null}
          recheck={recheck}
          describeAsset={describeAsset}
          explorer={chain.blockExplorer}
          next={
            loanId !== null
              ? {
                  label: format('accept.openLoan', { id: loanId.toString() }),
                  to: `/positions/${loanId.toString()}`,
                }
              : null
          }
          after={(outcome) =>
            credited === true && outcome.verdict !== 'not-done' ? (
              <p className="actions">
                <Link className="btn" to="/vault" data-testid="accept-withdraw">
                  {text('payout.withdrawNext')}
                </Link>
              </p>
            ) : null
          }
          gate={gate}
          onClose={close}
        />
      )}
    </div>
  );
}
