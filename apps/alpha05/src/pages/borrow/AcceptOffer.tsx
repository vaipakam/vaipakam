import { useEffect, useRef, useState } from 'react';
import { erc20Abi, type Abi } from 'viem';
import { useBlockNumber, useConfig } from 'wagmi';
import { signTypedData, waitForTransactionReceipt, writeContract } from 'wagmi/actions';
import { OfferAcceptFacetABI } from '@vaipakam/contracts/abis';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { useCopy } from '../../shared/copy/useCopy';
import { refusalFromError, StatedRefusal } from '../../shared/eligibility/refusal';
import { WhyLink } from '../../shared/help/WhyLink';
import { GUIDE_ORIGIN, guideUrl } from '../../shared/help/guide';
import { useMode } from '../../app/ModeContext';
import { ACCEPT_DEADLINE_SECONDS, ACCEPT_TERMS_DOMAIN_NAME, ACCEPT_TERMS_DOMAIN_VERSION, ACCEPT_TERMS_TYPES, buildAcceptTerms, freshNonce } from '../../shared/offers/acceptTerms';
import { deliverySplit, legVerdict, moved, openedLoan } from '../../shared/offers/acceptOutcome';
import { acceptFigures } from '../../shared/offers/model';
import { readVault, tokenAcceptsApproval } from '../../shared/offers/reads';
import { tokenAmount, type TokenMetaMap } from '../../shared/reads/tokens';
import { readTerms, termsUrl, type TermsState } from '../../shared/terms/terms';
import { askThrough } from '../../shared/tx/simulate';
import { useVisible } from '../../shared/reads/useVisible';
import { useStoredValue } from '../../shared/tx/txStore';
import { useTrackedTx } from '../../shared/tx/useTrackedTx';
import { allowanceSteps, setAllowance, type AllowanceIo } from '../../shared/tx/approval';
import type { LegOutcome } from '../../shared/tx/outcome';
import { ActionFlow, reviewIdentity, type Recheck } from '../../shared/ui/ActionFlow';
import { Notice } from '../../shared/ui/Notice';
import { shortAddress } from '../../shared/ui/format';
import { acceptReceipt, changedBetween, promptCount, readAcceptReview, reviewBlockers, type AcceptReview } from './acceptReview';

type Hex = `0x${string}`;

const ACCEPT_ABI = OfferAcceptFacetABI as Abi;

/** The store keys this flow keeps its state under, so a navigation or a
 *  wallet switch that unmounts the panel never drops a review, a consent or
 *  a transaction's hash (the tracker itself is under `borrow.accept`). */
export const ACCEPT_KEY = 'borrow.accept';

interface AcceptOfferProps {
  offerId: bigint;
  chain: SupportedChain;
  own: OwnStateClient;
  meta: TokenMetaMap | null;
  terms: TermsState | null;
  onClose: () => void;
}

/**
 * OFF-50 — a borrower takes a lender's offer whole. The review is built from
 * the protocol's own preview for this wallet and the offer as stored; the
 * single Risk and Terms consent is bound to the figures shown (a re-read
 * that moves any of them clears it); the wallet is asked to sign the exact
 * terms, then to approve exactly the collateral when needed, and the
 * acceptance is sent only after a dry run with that signature passes. If
 * anything stops it after an approval, the approval is put back (best
 * effort, stated either way). The outcome is measured from the
 * transaction's own logs: the loan it opened, what arrived in the wallet,
 * what moved into the vault.
 */
export function AcceptOffer({ offerId, chain, own, meta, terms, onClose }: AcceptOfferProps) {
  const copy = useCopy();
  const { text, format } = copy;
  const config = useConfig();
  const { mode } = useMode();
  const diamond = chain.diamondAddress;
  const account = own.account;
  const identity = reviewIdentity(own);
  const [review, setReview] = useStoredValue<AcceptReview>(`${ACCEPT_KEY}:review`);
  /** The review read the consent was given against (its `readAt`): a new
   *  read is a new set of figures, so the consent does not carry over. */
  const [consentFor, setConsentFor] = useStoredValue<number>(`${ACCEPT_KEY}:consent`);
  const [loanId, setLoanId] = useStoredValue<bigint>(`${ACCEPT_KEY}:loan`);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState<string | null>(null);
  /** The approval this flow made and has not yet seen used or put back: a
   *  submitted acceptance that reverts leaves it standing, so the receipt's
   *  measurement puts it back. A ref, because the measurement runs from the
   *  closure the tracker froze at submission. */
  const approvalLeft = useRef<{ token: Hex; prior: bigint; amount: bigint } | null>(null);

  const amt = (asset: Hex, v: bigint) => tokenAmount(v, asset, meta, format);

  const tx = useTrackedTx({
    key: ACCEPT_KEY,
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
      const collateral = r.offer.collateralAsset;
      const lock = r.preview.collateralAmount;
      approvalLeft.current = null;

      // The allowance is read again now: the value a stop puts back is the
      // one the wallet holds right before this flow's approval, never the
      // review's, and a change that alters the steps stops before any prompt.
      const io = allowanceIo(collateral, (amount, i, of) =>
        say(of === 2 && i === 0 ? text('accept.stepApproveZero') : format('accept.stepApprove', { amount: amt(collateral, amount) })),
      );
      const prior = await readAllowance(collateral);
      const steps = prior < lock ? await allowanceSteps(io, prior, lock) : [];
      const approved = steps.length > 0;
      if (steps.length !== r.approvalSteps)
        throw new StatedRefusal({
          code: 'AcceptChanged',
          reason: text('accept.allowanceMoved'),
          reopensAt: null,
          remedy: null,
        });

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
      if (approved) {
        // `prior` is the allowance this flow overwrites and a stop restores,
        // so nothing is sent if it moved while the terms were being signed.
        const set = await setAllowance(io, lock, prior);
        if (!set.ok) {
          // The wallet refused the first prompt: nothing was sent.
          if (set.why === 'refused' && set.sent === 0) throw new Error(set.reason ?? 'refused');
          if (set.why === 'changed') throw new StatedRefusal({ code: 'AcceptChanged', reason: text('accept.allowanceMoved'), reopensAt: null, remedy: null });
          // A step of this flow that landed (the one to zero, ahead of a
          // refused or failed one) left the allowance away from `prior`: it
          // is put back, but only while the allowance still reads the value
          // this flow set. Any other value (a replacement for a different
          // amount, another transaction) is stated, never overwritten.
          const back = set.pending === null && set.last !== null && set.now === set.last && set.now !== prior ? ` ${(await putBack(collateral, prior, set.last)).sentence}` : '';
          throw new StatedRefusal({
            code: 'ApprovalNotSet',
            reason:
              (set.pending !== null
                ? set.pending.amount === 0n
                  ? format('accept.approvalZeroUnread', { hash: set.pending.hash })
                  : format('accept.approvalUnread', { hash: set.pending.hash, amount: amt(collateral, set.pending.amount) })
                : format('accept.approvalNotSet', { amount: amt(collateral, lock), now: set.now === null ? text('accept.allowanceUnknown') : amt(collateral, set.now) })) + back,
            reopensAt: null,
            remedy: null,
          });
        }
        approvalLeft.current = { token: collateral, prior, amount: lock };
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
        const after = await putBack(collateral, prior, lock);
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
      const after = await putBack(left.token, left.prior, left.amount);
      const label = format('accept.legApprovalBack', { amount: amt(left.token, left.prior) });
      return after.ok ? { status: 'done', label } : { status: 'not-done', label, reason: after.sentence };
    },
    measure: async (receipt, at) => {
      if (!review) return [];
      const r = review;
      const f = acceptFigures(r.preview, r.offer.durationDays, r.matcherBps);
      const legs: LegOutcome[] = [];
      const opened = openedLoan(receipt.logs, diamond, offerId, account);
      if (opened) {
        setLoanId(opened.loanId);
        legs.push({
          status: 'done',
          label: format('accept.legLoan', { id: opened.loanId.toString() }),
        });
      } else {
        legs.push({
          status: 'not-done',
          label: format('accept.legNoLoan', { id: offerId.toString() }),
          reason: text('accept.noLoan'),
        });
      }
      // What reached the wallet (the principal less the fee, plus the fee
      // share the protocol pays the sender) and what else left the lender's
      // vault must add up to the principal the loan recorded, or the split
      // is not substantiated. A figure other than the preview's (the
      // discount tier is read again as the loan opens) is named beside it.
      const lending = r.offer.lendingAsset;
      const split = deliverySplit(receipt.logs, lending, account);
      const shownLabel = format('accept.legReceived', { amount: amt(lending, f.received) });
      if (split === null) {
        legs.push({ status: 'not-done', label: shownLabel, reason: text('accept.receivedNone') });
      } else if (opened && split.received + split.fee === opened.principal) {
        legs.push({
          status: 'done',
          label:
            split.received === f.received
              ? format('accept.legReceived', { amount: amt(lending, split.received) })
              : format('accept.legReceivedFee', { amount: amt(lending, split.received), shown: amt(lending, f.received), principal: amt(lending, opened.principal) }),
        });
      } else {
        legs.push({
          status: 'unknown',
          label: shownLabel,
          reason: format('accept.receivedOther', { amount: amt(lending, split.received), expected: amt(lending, f.received) }),
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
        const locked = moved(receipt.logs, collateral, account, vault);
        const lv = legVerdict(locked, f.collateral);
        legs.push(
          lv === 'done'
            ? { status: 'done', label: lockLabel }
            : {
                status: lv,
                label: lockLabel,
                reason: format('accept.lockedOther', {
                  amount: amt(collateral, locked),
                  expected: amt(collateral, f.collateral),
                }),
              },
        );
      }
      return legs;
    },
  });

  /** The wallet's allowance to the Diamond for `token`, now or at `block`. */
  async function readAllowance(token: Hex, block?: bigint): Promise<bigint> {
    const x = await own.read((c) =>
      c.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [account, diamond],
        blockNumber: block,
      }),
    );
    return x.value;
  }

  /** The wallet and chain operations the shared allowance rule runs on. */
  function allowanceIo(token: Hex, onStep?: AllowanceIo['onStep']): AllowanceIo {
    return {
      read: (block) => readAllowance(token, block),
      accepts: (amount) => own.read((c) => tokenAcceptsApproval(c, token, account, diamond, amount)).then((x) => x.value),
      send: (amount) =>
        writeContract(config, {
          address: token,
          abi: erc20Abi,
          functionName: 'approve',
          args: [diamond, amount],
          chainId: chain.chainId,
          account,
        }),
      wait: (hash) => waitForTransactionReceipt(config, { hash, chainId: chain.chainId }).then((m) => m.blockNumber),
      onStep,
    };
  }

  /** Puts the allowance back to `prior` (best effort, and only if nothing
   *  else changed it since the approval), and says what happened. */
  async function putBack(token: Hex, prior: bigint, approvedAmount: bigint): Promise<{ ok: boolean; sentence: string }> {
    // The same rule as the approval: the reset counts only when the
    // allowance reads `prior` after it, whatever the wallet did with it.
    const set = await setAllowance(
      allowanceIo(token, () => setStep(text('accept.stepRestore'))),
      prior,
      approvedAmount,
    ).catch((e: unknown) => ({ ok: false as const, why: 'refused' as const, sent: 0, now: null, last: null, pending: null, reason: refusalFromError(e).reason }));
    if (set.ok) return { ok: true, sentence: format('accept.restored', { amount: amt(token, prior) }) };
    const why =
      set.why === 'changed'
        ? text('accept.restoreChanged')
        : set.pending !== null
          ? format('accept.restorePending', { hash: set.pending.hash })
          : set.why === 'refused'
            ? (set.reason ?? text('accept.restoreNotLanded'))
            : text('accept.restoreNotLanded');
    // An allowance that could not be read is said to be unknown, never
    // filled in with the amount approved: the reset may have landed.
    if (set.now === null) return { ok: false, sentence: format('accept.restoreUnverified', { why }) };
    return { ok: false, sentence: format('accept.notRestored', { why, amount: amt(token, set.now) }) };
  }

  const load = async () => {
    try {
      const next = await readAcceptReview(own, diamond, offerId, identity);
      setLoadError(null);
      setReview(next);
    } catch (e) {
      setLoadError(refusalFromError(e).reason);
    }
  };

  const reviewOpened = useRef<bigint | null>(null);

  // RB-RAILS: the review gates an imminent money decision, so while it is on
  // screen (and nothing has been signed) it is read again each block. A
  // blocker that clears (the wallet funded, a vault upgraded, the protocol
  // unpaused) lifts without reopening the panel; a change to the figures
  // replaces the review and clears the consent given against the old ones.
  const visible = useVisible();
  const onReview = tx.phase.kind === 'review' && review !== null && review.offerId === offerId;
  const onReviewNow = useRef(onReview);
  useEffect(() => {
    onReviewNow.current = onReview;
  }, [onReview]);
  const head = useBlockNumber({ chainId: chain.chainId, watch: onReview && visible, query: { enabled: onReview } });
  const refreshing = useRef(false);
  useEffect(() => {
    if (!onReview || head.data === undefined || refreshing.current || review === null) return;
    const before = review;
    refreshing.current = true;
    readAcceptReview(own, diamond, offerId, before.identity)
      .then(
        (next) => {
          // Signing started meanwhile: the flow carries the review it began with.
          if (!onReviewNow.current) return;
          if (changedBetween(before, next, copy) !== null) {
            setReview(next);
            setConsentFor(null);
          } else setReview({ ...next, readAt: before.readAt });
        },
        // A failed refresh leaves the last review standing; Confirm re-reads.
        () => undefined,
      )
      .finally(() => {
        refreshing.current = false;
      });
    // The block number is the signal; the review read is taken as it stands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [head.data, onReview]);

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
  const riskLink = guideUrl(mode, 'borrow-risks');

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
            {review.consent === false && <p className="tier-b">{text('accept.feeOff')}</p>}
            <WhyLink summaryKey="accept.feeSummary" detailKey="accept.feeWhy" />
            <WhyLink summaryKey="accept.signSummary" detailKey="accept.signWhy" />
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
        signingNote={step}
        onClose={close}
      />
    </div>
  );
}
