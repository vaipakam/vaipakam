import { useEffect, useRef, useState } from 'react';
import { useConfig } from 'wagmi';
import { writeContract } from 'wagmi/actions';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { useCopy } from '../copy/useCopy';
import { refusalFromError, StatedRefusal } from '../eligibility/refusal';
import { WhyLink } from '../help/WhyLink';
import { GUIDE_ORIGIN, guideUrl } from '../help/guide';
import { useMode } from '../../app/ModeContext';
import { useCapabilities } from '../capability/CapabilityContext';
import { readNumeraireSymbol } from '../reads/numeraire';
import { useOwnRead } from '../reads/useOwnRead';
import { legVerdict, moved } from '../offers/acceptOutcome';
import { readVault } from '../offers/reads';
import { exactTokenAmount, tokenAmount, type TokenMetaMap } from '../reads/tokens';
import { readTerms, termsUrl, type TermsState } from '../terms/terms';
import { allowanceSteps } from '../tx/approval';
import { allowanceMoved, approvalFlow } from '../tx/approvalFlow';
import type { LegOutcome } from '../tx/outcome';
import { askThrough } from '../tx/simulate';
import { cleanUpLeg } from '../tx/cleanUp';
import { useStoredValue, useTxNote } from '../tx/txStore';
import { useMounted, useReviewRefresh } from '../tx/useReviewRefresh';
import { useTrackedTx } from '../tx/useTrackedTx';
import { ActionFlow, reviewIdentity, type Recheck } from '../ui/ActionFlow';
import { Notice } from '../ui/Notice';
import { shortAddress } from '../ui/format';
import { pageHandoff } from '../../routes/pageMap';
import { tariffStoreKeys, type ArmContext } from './ArmTariff';
import { createdOffer } from './postOutcome';
import { erc20Pair, nftCollateralPair, type RiskNeed } from '../risk/riskAccess';
import { nftApproval } from '../tx/nftApproval';
import { operatorApproval } from '../tx/operatorApproval';
import { quantityMoved, tokenMoved } from '../nft/nft';
import { assetName } from '../reads/tokens';
import { RiskGate, RiskStepFlow } from '../risk/RiskAccessStep';
import {
  approvalPrompts,
  changedBetween,
  CREATE_ABI,
  lockedName,
  promptCount,
  readPostReview,
  postBlockers,
  postRiskNeed,
  stakeOfDraft,
  type PostDraft,
  type PostReview,
} from './postReview';
import { postReceipt } from './postReceipt';
import { POST_KEYS, RISK_GUIDE } from './postCopy';
import { OFFER_TYPE } from './postModel';

type Hex = `0x${string}`;

interface PostOfferProps {
  /** The store key this flow's review, consent and tracker live under: one
   *  per page, so a request on Borrow and an offer on Lend never share one. */
  flowKey: string;
  draft: PostDraft;
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
 * OFF-05 / OFF-06 / OFF-16 / OFF-17 / OFF-19 — a borrower posts their own
 * request, or a lender their own offer (the draft's side). The review is the protocol's own verdict on the request as a dry run from
 * this wallet, with every figure it binds; the single Risk and Terms
 * consent is bound to that read. The wallet is asked to approve exactly the
 * stake (the collateral for a request, the amount for an offer: `stakeOf`)
 * when its allowance does not cover it, the request is dry-run
 * again with the approval in place, and only then sent. If anything stops it
 * after an approval, the approval is put back (best effort, stated either
 * way). The outcome is measured from the transaction's own logs: the
 * request or offer recorded, and the stake that moved into the vault. An
 * ERC-721 collateral (NFT-13) is approved for that one token only, never the
 * collection, and moving it into the vault clears the approval by itself.
 */
export function PostOffer({ flowKey, draft, chain, own, meta, terms, onEdit, onClose }: PostOfferProps) {
  const copy = useCopy();
  const k = POST_KEYS[draft.side];
  const { text, format } = copy;
  const config = useConfig();
  const { mode, isAdvanced } = useMode();
  const diamond = chain.diamondAddress;
  const account = own.account;
  const identity = reviewIdentity(own);
  // OFF-14: a closed schedule names the principal and the threshold in the
  // numeraire; the keeper's arming for the settlement pass is the capability
  // service's answer (unknown until it reports).
  const scheduled = draft.parsed.cadence !== 0;
  const numeraire = useOwnRead(['numeraireSymbol', diamond], (c) => readNumeraireSymbol(c, diamond), { enabled: scheduled });
  const unit = numeraire.data ?? '';
  const { caps } = useCapabilities();
  const settleKeeper = caps?.keeper.find((k) => k.pass === 'periodicSettle')?.armed ?? 'unknown';
  const [review, setReview] = useStoredValue<PostReview>(`${flowKey}:review`);
  const [consentFor, setConsentFor] = useStoredValue<number>(`${flowKey}:consent`);
  const [offerId, setOfferId] = useStoredValue<bigint>(`${flowKey}:offer`);
  const [, setArmContext] = useStoredValue<ArmContext>(tariffStoreKeys(flowKey).ctx);
  /** The risk-access step open in the review's place, if any (ACC-RISK). */
  const [riskOpen, setRiskOpen] = useStoredValue<RiskNeed>(`${flowKey}:risk`);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** The wallet step open now, kept with the tracker (it outlives the page). */
  const setStep = useTxNote(flowKey);
  /** The approval this flow made and has not yet seen used or put back (see
   *  AcceptOffer): a sent request that reverts leaves it standing.
   *  `since` is the block the approval mined in, so a put-back never reads
   *  the approval as it stood before it. */
  const approvalLeft = useRef<
    { kind: 'erc20'; token: Hex; prior: bigint; amount: bigint; since: bigint | null } | { kind: 'erc721'; token: Hex; tokenId: bigint; prior: Hex | null; since: bigint } | null
  >(null);
  /** An ERC-1155 operator approval this flow granted for the request alone
   *  (NFT-13): taken back on every ending, the request's success included,
   *  by the tracker's release step. `since` is the block the grant mined in. */
  const grantLeft = useRef<{ token: Hex; tokenId: bigint; since: bigint } | null>(null);
  const holdGrant = (v: { token: Hex; tokenId: bigint; since: bigint } | null) => {
    grantLeft.current = v;
  };

  const amt = (asset: Hex, v: bigint) => tokenAmount(v, asset, meta, format);
  // Every digit: what an approval is sent for, and the two figures a
  // measured-outcome mismatch compares (shortened, both could read the same).
  const exact = (asset: Hex, v: bigint) => exactTokenAmount(v, asset, meta, format);
  const { readAllowance, allowanceIo, approveExactly, putBack } = approvalFlow({ own, config, chainId: chain.chainId, diamond, copy, exactAmount: exact, setStep });
  /** The one-token approval for an ERC-721 collateral. */
  const tokenApproval = (asset: Hex, tokenId: bigint) =>
    nftApproval(
      { own, config, chainId: chain.chainId, diamond, copy, tokenName: format('asset.nft', { asset: assetName(asset, meta), id: String(tokenId) }), setStep },
      asset,
      tokenId,
    );

  /** The collection-wide approval an ERC-1155 collateral needs. Its revoke
   *  prompt is named as the last of the flow's numbered steps. */
  const operator = (asset: Hex, tokenId: bigint, say?: (what: string) => void) =>
    operatorApproval(
      { own, config, chainId: chain.chainId, diamond, copy, collection: assetName(asset, meta), setStep: (what) => (what === null || !say ? setStep(what) : say(what)) },
      asset,
      tokenId,
    );
  /** The flow's numbered prompts, kept across the tracker's release step. */
  const counter = useRef<{ n: number; total: number }>({ n: 0, total: 0 });

  const tx = useTrackedTx({
    key: flowKey,
    chainId: chain.chainId,
    account,
    sources: own.sources,
    send: async () => {
      if (!review) throw new Error('no request under review');
      const r = review;
      counter.current = { n: 0, total: promptCount(r) };
      const say = (what: string) => setStep(format('accept.stepOf', { n: String(++counter.current.n), total: String(counter.current.total), what }));
      const collateral = r.draft.pair.collateral;
      const stake = stakeOfDraft(r.draft);
      const h = r.holding;
      approvalLeft.current = null;
      holdGrant(null);

      // 1. The approval, when needed: exactly the collateral for an ERC-20,
      //    judged by the allowance each step leaves (shared/tx/approval), or
      //    the one token for an ERC-721, judged by the approval it reads
      //    after (shared/tx/nftApproval), or, for an ERC-1155 token, the
      //    operator approval for this request alone, taken back on every
      //    ending (shared/tx/operatorApproval). Each is read again first, so
      //    a change since the review stops before any prompt, and a stop
      //    puts back exactly what the wallet had right before.
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
      } else if (h.kind === 'erc1155') {
        const ap = operator(collateral, h.tokenId, say);
        const now = await ap.read();
        if ((now.approvedForAll ? 0 : 2) !== approvalPrompts(r)) throw allowanceMoved(copy);
        if (!now.approvedForAll) {
          say(format('operatorApproval.step', { collection: assetName(collateral, meta) }));
          const since = await ap.grant();
          holdGrant({ token: collateral, tokenId: h.tokenId, since });
          putItBack = () => {
            holdGrant(null);
            return ap.revoke(since);
          };
        }
      } else {
        // An ERC-20 stake: the collateral for a request, the amount for an offer.
        const token = stake.asset;
        const lock = stake.amount;
        const io = allowanceIo(token, (amount, i, of) => say(of === 2 && i === 0 ? text('approval.stepZero') : format('approval.step', { amount: exact(token, amount) })));
        const prior = await readAllowance(token);
        const steps = prior < lock ? await allowanceSteps(io, prior, lock) : [];
        if (steps.length !== h.approvalSteps) throw allowanceMoved(copy);
        if (steps.length > 0) {
          const since = await approveExactly(io, token, lock, prior);
          approvalLeft.current = { kind: 'erc20', token, prior, amount: lock, since };
          putItBack = () => putBack(token, prior, lock, since);
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
      if (dry.kind === 'reverted') return stop(format(k.dryRunRefused, { reason: refusalFromError(dry.error).reason }));
      if (dry.kind === 'unreadable') return stop(format('flow.unreadable', { reason: dry.reason }));

      // 3. The request or offer.
      say(text(k.stepSend));
      try {
        return await writeContract(config, { address: diamond, abi: CREATE_ABI, functionName: 'createOffer', args: [r.params], chainId: chain.chainId, account });
      } catch (e) {
        return stop(format(k.stoppedAfterApproval, { reason: refusalFromError(e).reason }));
      }
    },
    unwind: async () => {
      const left = approvalLeft.current;
      approvalLeft.current = null;
      if (!left) return null;
      if (left.kind === 'erc721') {
        const after = await tokenApproval(left.token, left.tokenId).putBack(left.prior, left.since);
        return cleanUpLeg(after, text('nftApproval.legBack'));
      }
      const after = await putBack(left.token, left.prior, left.amount, left.since);
      return cleanUpLeg(after, format('approval.legBack', { amount: exact(left.token, left.prior) }));
    },
    release: async () => {
      const left = grantLeft.current;
      holdGrant(null);
      if (!left) return null;
      const say = (what: string) => setStep(format('accept.stepOf', { n: String(++counter.current.n), total: String(counter.current.total), what }));
      const after = await operator(left.token, left.tokenId, say).revoke(left.since);
      return cleanUpLeg(after, format('operatorApproval.leg', { collection: assetName(left.token, meta) }));
    },
    held: () => (grantLeft.current ? format('operatorApproval.pendingNote', { collection: assetName(grantLeft.current.token, meta) }) : null),
    measure: async (receipt, at) => {
      if (!review) return [];
      const r = review;
      const legs: LegOutcome[] = [];
      const id = createdOffer(receipt.logs, diamond, account, OFFER_TYPE[r.draft.side]);
      if (id !== null) {
        setOfferId(id);
        // OFF-22: the tariff is armed by its own transaction once the
        // request exists, bound to the wallet and network that posted it.
        // The step is kept apart from this review (BorrowPage shows it), so
        // closing this card never drops it; until it confirms, loans open
        // without the tariff. Never cleared from here: the Borrow page
        // holds new requests back while a step is open, so one request's
        // posting can never replace or drop another's tariff step.
        if (r.draft.parsed.tariff) setArmContext({ identity: r.identity, offerId: id, choice: r.draft.parsed.tariff });
        legs.push({ status: 'done', label: format(POST_KEYS[r.draft.side].legOffer, { id: id.toString() }) });
      } else {
        legs.push({ status: 'not-done', label: text(POST_KEYS[r.draft.side].legNoOffer), reason: text(POST_KEYS[r.draft.side].noOffer) });
      }
      const collateral = r.draft.pair.collateral;
      const stake = stakeOfDraft(r.draft);
      const h = r.holding;
      const tokenName = lockedName(h, collateral, meta, format);
      const lockLabel = format('request.legLocked', { amount: h.kind === 'erc20' ? amt(stake.asset, stake.amount) : tokenName });
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
      } else if (h.kind === 'erc1155') {
        // The token's own TransferSingle / TransferBatch logs, from this
        // wallet to the vault, for exactly the quantity.
        const units = quantityMoved(receipt.logs, collateral, h.tokenId, account, vault);
        legs.push(
          units === h.quantity
            ? { status: 'done', label: lockLabel }
            : { status: 'not-done', label: lockLabel, reason: format('request.unitsNotLocked', { moved: String(units), expected: String(h.quantity), id: String(h.tokenId) }) },
        );
      } else {
        const locked = moved(receipt.logs, stake.asset, account, vault);
        const lv = legVerdict(locked, stake.amount);
        legs.push(
          lv === 'done'
            ? { status: 'done', label: lockLabel }
            : { status: lv, label: lockLabel, reason: format('request.lockedOther', { amount: exact(stake.asset, locked), expected: exact(stake.asset, stake.amount) }) },
        );
      }
      return legs;
    },
  });

  const mounted = useMounted();
  const load = async () => {
    try {
      const next = await readPostReview(own, diamond, draft, identity);
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
  useReviewRefresh<PostReview>({
    chainId: chain.chainId,
    active: onReview,
    review,
    read: (before) => readPostReview(own, diamond, before.draft, before.identity),
    sameSubject: (a, b) => a.draft === b.draft,
    changed: (before, next) => changedBetween(before, next, copy) !== null,
    setReview,
    onChanged: () => setConsentFor(null),
  });

  // Open the review for this draft when the panel opens on it: a review kept
  // for another draft (or none) is replaced; one in flight is kept.
  const opened = useRef<PostDraft | null>(null);
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
      readPostReview(own, diamond, draft, identity).then(
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
    let next: PostReview;
    let nowTerms: TermsState;
    try {
      [next, nowTerms] = await Promise.all([readPostReview(own, diamond, review.draft, review.identity), own.read((c) => readTerms(c, diamond, account)).then((x) => x.value)]);
    } catch (e) {
      return { kind: 'unreadable', reason: refusalFromError(e).reason };
    }
    if (nowTerms.kind === 'needed') return { kind: 'refused', refusal: { code: 'TermsNotAccepted', reason: text(k.termsNewer), reopensAt: null, remedy: null } };
    const what = changedBetween(review, next, copy);
    if (what !== null) {
      if (current()) {
        setReview(next);
        setConsentFor(null);
      }
      return { kind: 'changed', what };
    }
    const blockers = postBlockers(next, meta, copy, unit);
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
  const blockers = review ? postBlockers(review, meta, copy, unit) : [];
  const consented = review !== null && consentFor === review.readAt;
  const termsLink = terms && terms.kind !== 'none' ? termsUrl(terms.version) : `${GUIDE_ORIGIN}/terms`;
  const riskLink = guideUrl(mode, RISK_GUIDE[draft.side]);
  const riskNeed = review ? postRiskNeed(review) : null;
  const symbol = (a: Hex) => meta?.[a.toLowerCase()]?.symbol ?? shortAddress(a);
  const leg = review?.draft.pair.leg ?? null;
  const riskPair = review
    ? leg && leg.kind !== 'erc20'
      ? nftCollateralPair(review.draft.pair.lending, review.draft.pair.collateral, leg.kind === 'erc721' ? 1 : 2, leg.tokenId)
      : erc20Pair(review.draft.pair.lending, review.draft.pair.collateral)
    : null;
  const collLabel = review
    ? leg && leg.kind !== 'erc20'
      ? format('asset.nftToken', { asset: symbol(review.draft.pair.collateral), id: String(leg.tokenId) })
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
            <WhyLink summaryKey={k.feeSummary} detailKey={k.feeWhy} />
            <WhyLink summaryKey={k.postSummary} detailKey={k.postWhy} />
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
                  {text(k.edit)}
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
          receipt={review ? postReceipt(review, meta, copy, isAdvanced, settleKeeper) : null}
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
          onClose={close}
        />
      )}
    </div>
  );
}
