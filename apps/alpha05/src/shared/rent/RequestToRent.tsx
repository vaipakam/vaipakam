import { useEffect, useRef, useState } from 'react';
import { useConfig } from 'wagmi';
import { writeContract } from 'wagmi/actions';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { useMode } from '../../app/ModeContext';
import { useCopy } from '../copy/useCopy';
import { refusalFromError, StatedRefusal } from '../eligibility/refusal';
import { WhyLink } from '../help/WhyLink';
import { GUIDE_ORIGIN, guideUrl } from '../help/guide';
import { legVerdict, moved } from '../offers/acceptOutcome';
import { readVault } from '../offers/reads';
import { createdOffer } from '../post/postOutcome';
import { CREATE_ABI } from '../post/postReview';
import { OFFER_TYPE_BORROWER } from '../post/postModel';
import { RiskGate, RiskStepFlow } from '../risk/RiskAccessStep';
import type { RiskNeed } from '../risk/riskAccess';
import { exactTokenAmount, tokenAmount, type TokenMetaMap } from '../reads/tokens';
import { readTerms, termsUrl, type TermsState } from '../terms/terms';
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
import { shortAddress } from '../ui/format';
import type { ListDraft } from './listModel';
import { listedNftName } from './listReceipt';
import { rentalListPair } from './listReview';
import { requestReceipt } from './requestReceipt';
import {
  readRequestReview,
  requestBlockers,
  requestChangedBetween,
  requestCost,
  requestPromptCount,
  requestRefusal,
  requestRiskNeed,
  requestTokenNote,
  type RequestReview,
} from './requestReview';

type Hex = `0x${string}`;

/** The store key the renter's request flow lives under. */
export const RENT_REQUEST_KEY = 'rent.request';

interface RequestToRentProps {
  draft: ListDraft;
  chain: SupportedChain;
  own: OwnStateClient;
  meta: TokenMetaMap | null;
  terms: TermsState | null;
  /** Back to the form to change a figure (the typed request is kept). */
  onEdit: () => void;
  /** The flow is finished or abandoned; `posted` when the request was
   *  recorded, so the typed form is cleared. */
  onClose: (posted: boolean) => void;
}

/**
 * NFT-02 — a renter posts a request to rent a named NFT. The review is the
 * protocol's own verdict on the request as a dry run from this wallet, with
 * every term it binds; the single Risk and Terms consent is bound to that
 * read. The wallet approves exactly the rent and buffer when its allowance
 * falls short, the request is dry-run again with the approval in place, and
 * only then sent. If anything stops it after an approval, the approval is
 * put back (best effort, stated either way). The outcome is measured from
 * the transaction's own logs: the request recorded, and the rent and buffer
 * moved from the wallet into the renter's own vault.
 */
export function RequestToRent({ draft, chain, own, meta, terms, onEdit, onClose }: RequestToRentProps) {
  const copy = useCopy();
  const { text, format } = copy;
  const config = useConfig();
  const { mode } = useMode();
  const diamond = chain.diamondAddress;
  const account = own.account;
  const identity = reviewIdentity(own);
  const flowKey = RENT_REQUEST_KEY;
  const [review, setReview] = useStoredValue<RequestReview>(`${flowKey}:review`);
  const [consentFor, setConsentFor] = useStoredValue<number>(`${flowKey}:consent`);
  const [offerId, setOfferId] = useStoredValue<bigint>(`${flowKey}:offer`);
  const [riskOpen, setRiskOpen] = useStoredValue<RiskNeed>(`${flowKey}:risk`);
  const [loadError, setLoadError] = useState<string | null>(null);
  const setStep = useTxNote(flowKey);
  const approvalLeft = useRef<{ token: Hex; prior: bigint; amount: bigint; since: bigint | null } | null>(null);

  const amt = (asset: Hex, v: bigint) => tokenAmount(v, asset, meta, format);
  const exact = (asset: Hex, v: bigint) => exactTokenAmount(v, asset, meta, format);
  const { readAllowance, allowanceIo, approveExactly, putBack } = approvalFlow({ own, config, chainId: chain.chainId, diamond, copy, exactAmount: exact, setStep });

  const tx = useTrackedTx({
    key: flowKey,
    chainId: chain.chainId,
    account,
    sources: own.sources,
    send: async () => {
      if (!review) throw new Error('no request under review');
      const r = review;
      const total = requestPromptCount(r);
      let n = 0;
      const say = (what: string) => setStep(format('accept.stepOf', { n: String(++n), total: String(total), what }));
      const pay = r.draft.payment;
      const need = requestCost(r).total;
      approvalLeft.current = null;

      // 1. The approval, for exactly the rent and buffer, read again first so
      //    a change since the review stops before any prompt.
      const io = allowanceIo(pay, (amount, i, of) => say(of === 2 && i === 0 ? text('approval.stepZero') : format('approval.step', { amount: exact(pay, amount) })));
      const prior = await readAllowance(pay);
      const steps = prior < need ? await allowanceSteps(io, prior, need) : [];
      const approved = steps.length > 0;
      if (steps.length !== r.approvalSteps) throw allowanceMoved(copy);
      let since: bigint | null = null;
      if (approved) {
        since = await approveExactly(io, pay, need, prior);
        approvalLeft.current = { token: pay, prior, amount: need, since };
      }

      const stop = async (reason: string): Promise<never> => {
        if (!approved) throw new StatedRefusal({ code: 'RequestStopped', reason, reopensAt: null, remedy: null });
        approvalLeft.current = null;
        const after = await putBack(pay, prior, need, since);
        throw new StatedRefusal({ code: 'RequestStopped', reason: `${reason} ${after.sentence}`, reopensAt: null, remedy: null });
      };

      // 2. The dry run with the approval in place: the protocol's verdict on
      //    the whole request, the rent and buffer's move into the vault
      //    included.
      const dry = await askThrough(own, (c) => c.simulateContract({ address: diamond, abi: CREATE_ABI, functionName: 'createOffer', args: [r.params], account }));
      if (dry.kind === 'reverted') return stop(format('rentRequest.dryRunRefused', { reason: requestRefusal(dry.error, copy) }));
      if (dry.kind === 'unreadable') return stop(format('flow.unreadable', { reason: dry.reason }));

      // 3. The request.
      say(text('rentRequest.stepSend'));
      try {
        return await writeContract(config, { address: diamond, abi: CREATE_ABI, functionName: 'createOffer', args: [r.params], chainId: chain.chainId, account });
      } catch (e) {
        return stop(format('rentRequest.stoppedAfterApproval', { reason: requestRefusal(e, copy) }));
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
      const r = review;
      const legs: LegOutcome[] = [];
      const id = createdOffer(receipt.logs, diamond, account, OFFER_TYPE_BORROWER);
      if (id !== null) {
        setOfferId(id);
        legs.push({ status: 'done', label: format('rentRequest.legRequest', { id: id.toString() }) });
      } else {
        legs.push({ status: 'not-done', label: text('rentRequest.legNoRequest'), reason: text('rentRequest.noRequest') });
      }
      // The payment token's own Transfer logs, from this wallet to its vault,
      // for exactly the rent and buffer.
      const pay = r.draft.payment;
      const need = requestCost(r).total;
      const label = format('rentRequest.legHeld', { amount: amt(pay, need) });
      let vault: Hex | null = null;
      try {
        vault = await at.read((c, b) => readVault(c, diamond, account, b));
      } catch {
        vault = null;
      }
      if (vault === null) {
        legs.push({ status: 'unknown', label, reason: text('accept.vaultUnknown') });
      } else {
        const got = moved(receipt.logs, pay, account, vault);
        const v = legVerdict(got, need);
        legs.push(v === 'done' ? { status: 'done', label } : { status: v, label, reason: format('rent.prepaidOther', { amount: exact(pay, got), expected: exact(pay, need) }) });
      }
      return legs;
    },
  });

  const mounted = useMounted();
  const load = async () => {
    try {
      const next = await readRequestReview(own, diamond, draft, identity);
      if (!mounted.current) return;
      setLoadError(null);
      setReview(next);
    } catch (e) {
      setLoadError(refusalFromError(e).reason);
    }
  };

  // RB-RAILS: read again each block while the review is on screen.
  const onReview = tx.phase.kind === 'review' && review !== null && review.draft === draft;
  useReviewRefresh<RequestReview>({
    chainId: chain.chainId,
    active: onReview,
    review,
    read: (before) => readRequestReview(own, diamond, before.draft, before.identity),
    sameSubject: (a, b) => a.draft === b.draft,
    changed: (before, next) => requestChangedBetween(before, next, copy) !== null,
    setReview,
    onChanged: () => setConsentFor(null),
  });

  // Open the review for this draft when the panel opens on it.
  const opened = useRef<ListDraft | null>(null);
  useEffect(() => {
    const open = tx.phase.kind === 'idle' || tx.phase.kind === 'review';
    if (!open) return;
    if (tx.phase.kind === 'idle' && opened.current !== draft) {
      opened.current = draft;
      tx.review();
    }
    if (review === null || review.draft !== draft) {
      setReview(null);
      setConsentFor(null);
      setOfferId(null);
      setRiskOpen(null);
      let live = true;
      readRequestReview(own, diamond, draft, identity).then(
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
    // Opened once per draft; the tracker and the stored review carry the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const recheck = async (current: () => boolean): Promise<Recheck> => {
    if (!review) return { kind: 'unreadable', reason: text('flow.reading') };
    let next: RequestReview;
    let nowTerms: TermsState;
    try {
      [next, nowTerms] = await Promise.all([readRequestReview(own, diamond, review.draft, review.identity), own.read((c) => readTerms(c, diamond, account)).then((x) => x.value)]);
    } catch (e) {
      return { kind: 'unreadable', reason: refusalFromError(e).reason };
    }
    if (nowTerms.kind === 'needed') return { kind: 'refused', refusal: { code: 'TermsNotAccepted', reason: text('rentRequest.termsNewer'), reopensAt: null, remedy: null } };
    const what = requestChangedBetween(review, next, copy);
    if (what !== null) {
      if (current()) {
        setReview(next);
        setConsentFor(null);
      }
      return { kind: 'changed', what };
    }
    const blockers = requestBlockers(next, meta, copy);
    if (blockers.length > 0) return { kind: 'refused', refusal: { code: 'RequestBlocked', reason: blockers[0]!, reopensAt: null, remedy: null } };
    return { kind: 'ok' };
  };

  const clear = () => {
    setReview(null);
    setConsentFor(null);
    setOfferId(null);
    setStep(null);
    setRiskOpen(null);
  };
  const close = () => {
    const posted = offerId !== null;
    clear();
    onClose(posted);
  };
  const edit = () => {
    tx.reset();
    clear();
    onEdit();
  };

  const blockers = review ? requestBlockers(review, meta, copy) : [];
  const missingToken = review !== null && requestTokenNote(review) === 'no-token';
  const consented = review !== null && consentFor === review.readAt;
  const termsLink = terms && terms.kind !== 'none' ? termsUrl(terms.version) : `${GUIDE_ORIGIN}/terms`;
  const riskLink = guideUrl(mode, 'rent-request-risks');
  const riskNeed = review ? requestRiskNeed(review) : null;
  const riskPair = review ? rentalListPair(review.draft) : null;
  const symbol = (a: Hex) => meta?.[a.toLowerCase()]?.symbol ?? shortAddress(a);
  const pairLabel = review ? format('rent.pairName', { nft: listedNftName(review, meta, format), pay: symbol(review.draft.payment) }) : '';

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
            {missingToken && (
              <Notice tone="warn" tier="A">
                {format('rentRequest.noTokenYet', { id: String(review.draft.tokenId) })}
              </Notice>
            )}
            {riskNeed !== null && riskPair !== null && (
              <RiskGate chain={chain} own={own} need={riskNeed} source={{ kind: 'pair', pair: riskPair }} pairLabel={pairLabel} onOpen={() => setRiskOpen(riskNeed)} />
            )}
            <WhyLink summaryKey="rentRequest.whySummary" detailKey="rentRequest.why" />
            {blockers.length === 0 && (
              <p className="consent tier-a">
                <label>
                  <input type="checkbox" checked={consented} onChange={(e) => setConsentFor(e.target.checked ? review.readAt : null)} data-testid="rent-request-consent" />
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
            {tx.phase.kind === 'review' && (
              <p>
                <button type="button" className="btn btn-link" onClick={edit} data-testid="rent-request-edit">
                  {text('rentRequest.edit')}
                </button>
              </p>
            )}
          </div>
        ),
      }
    : undefined;

  const describeAsset = (a: Hex) => {
    const m = meta?.[a.toLowerCase()];
    return m && m.decimals !== null ? { symbol: m.symbol ?? shortAddress(a), decimals: m.decimals } : null;
  };

  return (
    <div className="rent-request-flow" data-testid="rent-request-flow">
      {loadError !== null && (
        <Notice tone="warn" tier="A">
          {format('flow.unreadable', { reason: loadError })}{' '}
          <button type="button" className="btn" onClick={() => void load()}>
            {text('consent.retry')}
          </button>
        </Notice>
      )}
      {riskOpen !== null && riskPair !== null ? (
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
          publicQueue
          identity={identity}
          reviewedFor={review?.identity ?? tx.frozen?.identity ?? identity}
          receipt={review ? requestReceipt(review, meta, copy) : null}
          recheck={recheck}
          describeAsset={describeAsset}
          explorer={chain.blockExplorer}
          next={offerId === null ? null : { label: format('rentRequest.openRequest', { id: offerId.toString() }), to: `/offers/${offerId.toString()}` }}
          gate={gate}
          onClose={close}
        />
      )}
    </div>
  );
}
