import { useEffect, useRef, useState } from 'react';
import { useConfig } from 'wagmi';
import { writeContract } from 'wagmi/actions';
import type { OwnStateClient } from '../../../chain/ownRail';
import type { SupportedChain } from '../../../chain/chains';
import { useCopy } from '../../../shared/copy/useCopy';
import { refusalFromError, StatedRefusal } from '../../../shared/eligibility/refusal';
import { WhyLink } from '../../../shared/help/WhyLink';
import { GUIDE_ORIGIN, guideUrl } from '../../../shared/help/guide';
import { useMode } from '../../../app/ModeContext';
import { legVerdict, moved } from '../../../shared/offers/acceptOutcome';
import { readVault } from '../../../shared/offers/reads';
import { tokenAmount, type TokenMetaMap } from '../../../shared/reads/tokens';
import { readTerms, termsUrl, type TermsState } from '../../../shared/terms/terms';
import { allowanceSteps } from '../../../shared/tx/approval';
import { allowanceMoved, approvalFlow } from '../../../shared/tx/approvalFlow';
import type { LegOutcome } from '../../../shared/tx/outcome';
import { askThrough } from '../../../shared/tx/simulate';
import { useStoredValue } from '../../../shared/tx/txStore';
import { useMounted, useReviewRefresh } from '../../../shared/tx/useReviewRefresh';
import { useTrackedTx } from '../../../shared/tx/useTrackedTx';
import { ActionFlow, reviewIdentity, type Recheck } from '../../../shared/ui/ActionFlow';
import { Notice } from '../../../shared/ui/Notice';
import { shortAddress } from '../../../shared/ui/format';
import { pageHandoff } from '../../../routes/pageMap';
import { REQUEST_KEY } from './RequestForm';
import { createdRequest } from './requestOutcome';
import { erc20Pair, erc721CollateralPair, type RiskNeed } from '../../../shared/risk/riskAccess';
import { nftApproval } from '../../../shared/tx/nftApproval';
import { tokenMoved } from '../../../shared/nft/nft';
import { assetName } from '../../../shared/reads/tokens';
import { RiskGate, RiskStepFlow } from '../../../shared/risk/RiskAccessStep';
import {
  approvalPrompts,
  changedBetween,
  CREATE_ABI,
  promptCount,
  readRequestReview,
  requestBlockers,
  requestReceipt,
  requestRiskNeed,
  type RequestDraft,
  type RequestReview,
} from './requestReview';

type Hex = `0x${string}`;

interface PostRequestProps {
  draft: RequestDraft;
  chain: SupportedChain;
  own: OwnStateClient;
  meta: TokenMetaMap | null;
  terms: TermsState | null;
  /** Back to the form to change a figure (the typed request is kept). */
  onEdit: () => void;
  /** The flow is finished or abandoned: the page returns to the offers;
   *  `posted` when the request was recorded, so the typed form is cleared. */
  onClose: (posted: boolean) => void;
}

/**
 * OFF-05 / OFF-16 / OFF-17 / OFF-19 — a borrower posts their own request.
 * The review is the protocol's own verdict on the request as a dry run from
 * this wallet, with every figure it binds; the single Risk and Terms
 * consent is bound to that read. The wallet is asked to approve exactly the
 * collateral when its allowance does not cover it, the request is dry-run
 * again with the approval in place, and only then sent. If anything stops it
 * after an approval, the approval is put back (best effort, stated either
 * way). The outcome is measured from the transaction's own logs: the
 * request recorded, and the collateral that moved into the vault. An
 * ERC-721 collateral (NFT-13) is approved for that one token only, never the
 * collection, and moving it into the vault clears the approval by itself.
 */
export function PostRequest({ draft, chain, own, meta, terms, onEdit, onClose }: PostRequestProps) {
  const copy = useCopy();
  const { text, format } = copy;
  const config = useConfig();
  const { mode } = useMode();
  const diamond = chain.diamondAddress;
  const account = own.account;
  const identity = reviewIdentity(own);
  const [review, setReview] = useStoredValue<RequestReview>(`${REQUEST_KEY}:review`);
  const [consentFor, setConsentFor] = useStoredValue<number>(`${REQUEST_KEY}:consent`);
  const [offerId, setOfferId] = useStoredValue<bigint>(`${REQUEST_KEY}:offer`);
  /** The risk-access step open in the review's place, if any (ACC-RISK). */
  const [riskOpen, setRiskOpen] = useStoredValue<RiskNeed>(`${REQUEST_KEY}:risk`);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState<string | null>(null);
  /** The approval this flow made and has not yet seen used or put back (see
   *  AcceptOffer): a sent request that reverts leaves it standing.
   *  `since` is the block the approval mined in, so a put-back never reads
   *  the approval as it stood before it. */
  const approvalLeft = useRef<
    { kind: 'erc20'; token: Hex; prior: bigint; amount: bigint; since: bigint | null } | { kind: 'erc721'; token: Hex; tokenId: bigint; prior: Hex | null; since: bigint } | null
  >(null);

  const amt = (asset: Hex, v: bigint) => tokenAmount(v, asset, meta, format);
  const { readAllowance, allowanceIo, approveExactly, putBack } = approvalFlow({ own, config, chainId: chain.chainId, diamond, copy, amount: amt, setStep });
  /** The one-token approval for an ERC-721 collateral. */
  const tokenApproval = (asset: Hex, tokenId: bigint) =>
    nftApproval(
      { own, config, chainId: chain.chainId, diamond, copy, tokenName: format('asset.nft', { asset: assetName(asset, meta), id: String(tokenId) }), setStep },
      asset,
      tokenId,
    );

  const tx = useTrackedTx({
    key: REQUEST_KEY,
    chainId: chain.chainId,
    account,
    sources: own.sources,
    send: async () => {
      if (!review) throw new Error('no request under review');
      const r = review;
      const total = promptCount(r);
      let n = 0;
      const say = (what: string) => setStep(format('accept.stepOf', { n: String(++n), total: String(total), what }));
      const collateral = r.draft.pair.collateral;
      const lock = r.draft.parsed.collateral;
      const h = r.holding;
      approvalLeft.current = null;

      // 1. The approval, when needed: exactly the collateral for an ERC-20,
      //    judged by the allowance each step leaves (shared/tx/approval), or
      //    the one token for an ERC-721, judged by the approval it reads
      //    after (shared/tx/nftApproval). Each is read again first, so a
      //    change since the review stops before any prompt, and a stop puts
      //    back exactly what the wallet had right before.
      let putItBack: (() => Promise<{ sentence: string }>) | null = null;
      if (h.kind === 'erc721') {
        const ap = tokenApproval(collateral, h.tokenId);
        const now = await ap.read();
        const needed = !(now.approvedForAll || (now.approved !== null && now.approved.toLowerCase() === diamond.toLowerCase()));
        if ((needed ? 1 : 0) !== approvalPrompts(r)) throw allowanceMoved(copy);
        if (needed) {
          say(format('nftApproval.step', { token: format('asset.nft', { asset: assetName(collateral, meta), id: String(h.tokenId) }) }));
          const since = await ap.approve(now.approved);
          approvalLeft.current = { kind: 'erc721', token: collateral, tokenId: h.tokenId, prior: now.approved, since };
          putItBack = () => ap.putBack(now.approved, since);
        }
      } else {
        const io = allowanceIo(collateral, (amount, i, of) => say(of === 2 && i === 0 ? text('approval.stepZero') : format('approval.step', { amount: amt(collateral, amount) })));
        const prior = await readAllowance(collateral);
        const steps = prior < lock ? await allowanceSteps(io, prior, lock) : [];
        if (steps.length !== h.approvalSteps) throw allowanceMoved(copy);
        if (steps.length > 0) {
          const since = await approveExactly(io, collateral, lock, prior);
          approvalLeft.current = { kind: 'erc20', token: collateral, prior, amount: lock, since };
          putItBack = () => putBack(collateral, prior, lock, since);
        }
      }

      const stop = async (reason: string): Promise<never> => {
        if (putItBack === null) throw new StatedRefusal({ code: 'RequestStopped', reason, reopensAt: null, remedy: null });
        approvalLeft.current = null;
        const after = await putItBack();
        throw new StatedRefusal({ code: 'RequestStopped', reason: `${reason} ${after.sentence}`, reopensAt: null, remedy: null });
      };

      // 2. The dry run with the approval in place: the protocol's verdict
      //    on the whole request, collateral pull included.
      const dry = await askThrough(own, (c) => c.simulateContract({ address: diamond, abi: CREATE_ABI, functionName: 'createOffer', args: [r.params], account }));
      if (dry.kind === 'reverted') return stop(format('request.dryRunRefused', { reason: refusalFromError(dry.error).reason }));
      if (dry.kind === 'unreadable') return stop(format('flow.unreadable', { reason: dry.reason }));

      // 3. The request.
      say(text('request.stepSend'));
      try {
        return await writeContract(config, { address: diamond, abi: CREATE_ABI, functionName: 'createOffer', args: [r.params], chainId: chain.chainId, account });
      } catch (e) {
        return stop(format('request.stoppedAfterApproval', { reason: refusalFromError(e).reason }));
      }
    },
    unwind: async () => {
      const left = approvalLeft.current;
      approvalLeft.current = null;
      if (!left) return null;
      if (left.kind === 'erc721') {
        const after = await tokenApproval(left.token, left.tokenId).putBack(left.prior, left.since);
        const label = text('nftApproval.legBack');
        return after.ok ? { status: 'done', label } : { status: 'not-done', label, reason: after.sentence };
      }
      const after = await putBack(left.token, left.prior, left.amount, left.since);
      const label = format('approval.legBack', { amount: amt(left.token, left.prior) });
      return after.ok ? { status: 'done', label } : { status: 'not-done', label, reason: after.sentence };
    },
    measure: async (receipt, at) => {
      if (!review) return [];
      const r = review;
      const legs: LegOutcome[] = [];
      const id = createdRequest(receipt.logs, diamond, account);
      if (id !== null) {
        setOfferId(id);
        legs.push({ status: 'done', label: format('request.legOffer', { id: id.toString() }) });
      } else {
        legs.push({ status: 'not-done', label: text('request.legNoOffer'), reason: text('request.noOffer') });
      }
      const collateral = r.draft.pair.collateral;
      const lock = r.draft.parsed.collateral;
      const h = r.holding;
      const tokenName = h.kind === 'erc721' ? format('asset.nft', { asset: assetName(collateral, meta), id: String(h.tokenId) }) : '';
      const lockLabel = format('request.legLocked', { amount: h.kind === 'erc721' ? tokenName : amt(collateral, lock) });
      let vault: Hex | null = null;
      try {
        vault = await at.read((c, b) => readVault(c, diamond, account, b));
      } catch {
        vault = null;
      }
      if (vault === null) {
        legs.push({ status: 'unknown', label: lockLabel, reason: text('accept.vaultUnknown') });
      } else if (h.kind === 'erc721') {
        // The token's own Transfer log, from this wallet to the vault.
        legs.push(
          tokenMoved(receipt.logs, collateral, h.tokenId, account, vault)
            ? { status: 'done', label: lockLabel }
            : { status: 'not-done', label: lockLabel, reason: format('request.tokenNotLocked', { token: tokenName }) },
        );
      } else {
        const locked = moved(receipt.logs, collateral, account, vault);
        const lv = legVerdict(locked, lock);
        legs.push(
          lv === 'done'
            ? { status: 'done', label: lockLabel }
            : { status: lv, label: lockLabel, reason: format('request.lockedOther', { amount: amt(collateral, locked), expected: amt(collateral, lock) }) },
        );
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

  // RB-RAILS: read again each block while the review is on screen; a late
  // answer never lands on another draft's review (useReviewRefresh).
  const onReview = tx.phase.kind === 'review' && review !== null && review.draft === draft;
  useReviewRefresh<RequestReview>({
    chainId: chain.chainId,
    active: onReview,
    review,
    read: (before) => readRequestReview(own, diamond, before.draft, before.identity),
    sameSubject: (a, b) => a.draft === b.draft,
    changed: (before, next) => changedBetween(before, next, copy) !== null,
    setReview,
    onChanged: () => setConsentFor(null),
  });

  // Open the review for this draft when the panel opens on it: a review kept
  // for another draft (or none) is replaced; one in flight is kept.
  const opened = useRef<RequestDraft | null>(null);
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
    if (nowTerms.kind === 'needed') return { kind: 'refused', refusal: { code: 'TermsNotAccepted', reason: text('request.termsNewer'), reopensAt: null, remedy: null } };
    const what = changedBetween(review, next, copy);
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
  // Back to the form from the review: nothing was asked of the wallet, so
  // the tracker returns to idle and the typed request is kept.
  const edit = () => {
    tx.reset();
    clear();
    onEdit();
  };

  // Where the request is followed and cancelled once posted (built page or
  // the current app's), said before the collateral locks.
  const offersPage = pageHandoff('/offers');
  const blockers = review ? requestBlockers(review, meta, copy) : [];
  const consented = review !== null && consentFor === review.readAt;
  const termsLink = terms && terms.kind !== 'none' ? termsUrl(terms.version) : `${GUIDE_ORIGIN}/terms`;
  const riskLink = guideUrl(mode, 'borrow-risks');
  const riskNeed = review ? requestRiskNeed(review) : null;
  const symbol = (a: Hex) => meta?.[a.toLowerCase()]?.symbol ?? shortAddress(a);
  const leg = review?.draft.pair.leg ?? null;
  const riskPair = review
    ? leg?.kind === 'erc721'
      ? erc721CollateralPair(review.draft.pair.lending, review.draft.pair.collateral, leg.tokenId)
      : erc20Pair(review.draft.pair.lending, review.draft.pair.collateral)
    : null;
  const collLabel = review
    ? leg?.kind === 'erc721'
      ? format('asset.nft', { asset: symbol(review.draft.pair.collateral), id: String(leg.tokenId) })
      : symbol(review.draft.pair.collateral)
    : '';
  const pairLabel = review ? format('risk.pairName', { lend: symbol(review.draft.pair.lending), coll: collLabel }) : '';

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
            {riskNeed !== null && riskPair !== null && (
              <RiskGate chain={chain} own={own} need={riskNeed} source={{ kind: 'pair', pair: riskPair }} pairLabel={pairLabel} onOpen={() => setRiskOpen(riskNeed)} />
            )}
            {offersPage.kind === 'currentApp' && (
              // The receipt's consequences say why; this is the way there.
              <p className="tier-b">
                <a href={offersPage.href} target="_blank" rel="noreferrer" data-testid="request-manage-link">
                  {text('request.manageLink')}
                </a>
              </p>
            )}
            <WhyLink summaryKey="accept.feeSummary" detailKey="accept.feeWhy" />
            <WhyLink summaryKey="request.postSummary" detailKey="request.postWhy" />
            {blockers.length === 0 && (
              <p className="consent tier-a">
                <label>
                  <input type="checkbox" checked={consented} onChange={(e) => setConsentFor(e.target.checked ? review.readAt : null)} data-testid="request-consent" />
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
                <button type="button" className="btn btn-link" onClick={edit} data-testid="request-edit">
                  {text('request.edit')}
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
    <div className="post-request">
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
          flowKey={REQUEST_KEY}
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
          receipt={review ? requestReceipt(review, meta, copy) : null}
          recheck={recheck}
          describeAsset={describeAsset}
          explorer={chain.blockExplorer}
          next={
            offerId === null || offersPage.kind === 'none'
              ? null
              : offersPage.kind === 'here'
                ? { label: text('request.openOffers'), to: offersPage.to }
                : { label: text('request.openOffersCurrent'), href: offersPage.href }
          }
          gate={gate}
          signingNote={step}
          onClose={close}
        />
      )}
    </div>
  );
}
