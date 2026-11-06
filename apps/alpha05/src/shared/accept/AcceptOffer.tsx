import { useEffect, useRef, useState } from 'react';
import type { Abi, Log } from 'viem';
import { useConfig } from 'wagmi';
import { signTypedData, writeContract } from 'wagmi/actions';
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
import { needFromAcceptCode, type RiskNeed } from '../risk/riskAccess';
import { RiskGate, RiskStepFlow } from '../risk/RiskAccessStep';
import { changedBetween, paid, promptCount, readAcceptReview, reviewBlockers, type AcceptReview } from './acceptReview';
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
  offerId: bigint;
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
export function AcceptOffer({ flowKey, offerId, chain, own, meta, terms, onClose }: AcceptOfferProps) {
  const copy = useCopy();
  const { text, format } = copy;
  const config = useConfig();
  const { mode } = useMode();
  const diamond = chain.diamondAddress;
  const account = own.account;
  const identity = reviewIdentity(own);
  const [review, setReview] = useStoredValue<AcceptReview>(`${flowKey}:review`);
  /** The review read the consent was given against (its `readAt`): a new
   *  read is a new set of figures, so the consent does not carry over. */
  const [consentFor, setConsentFor] = useStoredValue<number>(`${flowKey}:consent`);
  const [loanId, setLoanId] = useStoredValue<bigint>(`${flowKey}:loan`);
  /** The risk-access step open in the review's place, if any (ACC-RISK). */
  const [riskOpen, setRiskOpen] = useStoredValue<RiskNeed>(`${flowKey}:risk`);
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

      // 3. The dry run with the real signature: the protocol's own verdict.
      const dry = await askThrough(own, (c) =>
        c.simulateContract({
          address: diamond,
          abi: ACCEPT_ABI,
          functionName: 'acceptOffer',
          args: [offerId, message, signature],
          account,
        }),
      );
      if (dry.kind === 'reverted')
        return stop(
          format('accept.dryRunRefused', {
            reason: refusalFromError(dry.error).reason,
          }),
        );
      if (dry.kind === 'unreadable') return stop(format('flow.unreadable', { reason: dry.reason }));

      // 4. The acceptance.
      say(text('accept.stepSend'));
      try {
        return await writeContract(config, {
          address: diamond,
          abi: ACCEPT_ABI,
          functionName: 'acceptOffer',
          args: [offerId, message, signature],
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
      return review.role === 'borrower' ? measureBorrower(review, receipt.logs, at) : measureLender(review, receipt.logs);
    },
  });

  /** A borrower's acceptance: the loan, what reached the wallet, and the
   *  collateral locked in the vault. */
  const measureBorrower = async (r: AcceptReview, logs: readonly Log[], at: AnchoredReader): Promise<LegOutcome[]> => {
    const f = acceptFigures(r.preview, r.offer.durationDays, r.matcherBps);
    const legs: LegOutcome[] = [];
    const opened = openedLoan(logs, diamond, offerId, account);
    legs.push(loanLeg(opened, 'accept.legLoan'));
    // What reached the wallet (the principal less the fee, plus the fee
    // share the protocol pays the sender) and what else left the lender's
    // vault must add up to the principal the loan recorded, or the split
    // is not substantiated. A figure other than the preview's (the
    // discount tier is read again as the loan opens) is named beside it.
    const lending = r.offer.lendingAsset;
    const split = deliverySplit(logs, lending, account);
    const shownLabel = format('accept.legReceived', { amount: amt(lending, f.received) });
    if (split === null) {
      legs.push({ status: 'not-done', label: shownLabel, reason: text('accept.receivedNone') });
    } else if (opened && split.received + split.fee === opened.principal) {
      legs.push({
        status: 'done',
        label:
          split.received === f.received
            ? format('accept.legReceived', { amount: amt(lending, split.received) })
            : format('accept.legReceivedFee', { amount: exact(lending, split.received), shown: exact(lending, f.received), principal: exact(lending, opened.principal) }),
      });
    } else {
      legs.push({
        status: 'unknown',
        label: shownLabel,
        reason: format('accept.receivedOther', { amount: exact(lending, split.received), expected: exact(lending, f.received) }),
      });
    }
    const collateral = r.offer.collateralAsset;
    const lockLabel = format('accept.legLocked', {
      amount: amt(collateral, f.collateral),
    });
    let vault: Hex | null = null;
    try {
      vault = await at.read((c, b) => readVault(c, diamond, account, b));
    } catch {
      vault = null;
    }
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
  const measureLender = (r: AcceptReview, logs: readonly Log[]): LegOutcome[] => {
    const f = lenderFigures(r.preview, r.offer.durationDays, r.matcherBps, 0n);
    const lending = r.offer.lendingAsset;
    const legs: LegOutcome[] = [loanLeg(openedLoan(logs, diamond, offerId, r.offer.creator), 'lendAccept.legLoan')];
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

  const loanLeg = (opened: ReturnType<typeof openedLoan>, key: 'accept.legLoan' | 'lendAccept.legLoan'): LegOutcome => {
    if (opened) {
      setLoanId(opened.loanId);
      return { status: 'done', label: format(key, { id: opened.loanId.toString() }) };
    }
    return { status: 'not-done', label: format('accept.legNoLoan', { id: offerId.toString() }), reason: text('accept.noLoan') };
  };

  const mounted = useMounted();
  const load = async () => {
    try {
      const next = await readAcceptReview(own, diamond, offerId, identity);
      if (!mounted.current) return;
      setLoadError(null);
      setReview(next);
    } catch (e) {
      setLoadError(refusalFromError(e).reason);
    }
  };

  const reviewOpened = useRef<bigint | null>(null);

  // RB-RAILS: read again each block while the review is on screen; a late
  // answer never lands on another offer's review (useReviewRefresh).
  const onReview = tx.phase.kind === 'review' && review !== null && review.offerId === offerId;
  useReviewRefresh<AcceptReview>({
    chainId: chain.chainId,
    active: onReview,
    review,
    read: (before) => readAcceptReview(own, diamond, before.offerId, before.identity),
    sameSubject: (a, b) => a.offerId === b.offerId,
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
    if (tx.phase.kind === 'idle' && reviewOpened.current !== offerId) {
      reviewOpened.current = offerId;
      tx.review();
    }
    if (review === null || review.offerId !== offerId) {
      setReview(null);
      setConsentFor(null);
      setLoanId(null);
      setRiskOpen(null);
      let live = true;
      readAcceptReview(own, diamond, offerId, identity).then(
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
    // Opened once per offer; the tracker and the stored review carry the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offerId]);

  const recheck = async (current: () => boolean): Promise<Recheck> => {
    if (!review) return { kind: 'unreadable', reason: text('flow.reading') };
    let next: AcceptReview;
    let nowTerms: TermsState;
    try {
      // OFF-35 holds at the moment the wallet opens, not only when the flow
      // did: a Terms version published since the review is accepted first.
      [next, nowTerms] = await Promise.all([readAcceptReview(own, diamond, offerId, review.identity), own.read((c) => readTerms(c, diamond, account)).then((r) => r.value)]);
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
  const riskNeed = review !== null && review.creatorGate === 0 ? needFromAcceptCode(review.gate) : null;
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
              <RiskGate chain={chain} own={own} need={riskNeed} source={{ kind: 'offer', offerId }} pairLabel={pairLabel} onOpen={() => setRiskOpen(riskNeed)} />
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
    onClose();
  };

  return (
    <div className="accept-offer" data-offer-id={offerId.toString()}>
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
          source={{ kind: 'offer', offerId }}
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
          gate={gate}
          onClose={close}
        />
      )}
    </div>
  );
}
