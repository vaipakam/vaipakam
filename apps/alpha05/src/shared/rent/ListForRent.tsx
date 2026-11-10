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
import { quantityMoved, tokenMoved } from '../nft/nft';
import { readVault } from '../offers/reads';
import { createdOffer } from '../post/postOutcome';
import { CREATE_ABI } from '../post/postReview';
import { OFFER_TYPE_LENDER } from '../post/postModel';
import { RiskGate, RiskStepFlow } from '../risk/RiskAccessStep';
import type { RiskNeed } from '../risk/riskAccess';
import { assetName, type TokenMetaMap } from '../reads/tokens';
import { readTerms, termsUrl, type TermsState } from '../terms/terms';
import { allowanceMoved } from '../tx/approvalFlow';
import { cleanUpLeg } from '../tx/cleanUp';
import { nftApproval } from '../tx/nftApproval';
import { operatorApproval } from '../tx/operatorApproval';
import type { LegOutcome } from '../tx/outcome';
import { askThrough } from '../tx/simulate';
import { useStoredValue, useTxNote } from '../tx/txStore';
import { useMounted, useReviewRefresh } from '../tx/useReviewRefresh';
import { useTrackedTx } from '../tx/useTrackedTx';
import { ActionFlow, reviewIdentity, type Recheck } from '../ui/ActionFlow';
import { Notice } from '../ui/Notice';
import { shortAddress } from '../ui/format';
import type { ListDraft } from './listModel';
import { listedNftName, listReceipt } from './listReceipt';
import { listApprovalPrompts, listBlockers, listChangedBetween, listPromptCount, listRefusal, listRiskNeed, readListReview, rentalListPair, type ListReview } from './listReview';

type Hex = `0x${string}`;

/** The store key the owner's listing flow lives under. */
export const RENT_LIST_KEY = 'rent.list';

interface ListForRentProps {
  draft: ListDraft;
  chain: SupportedChain;
  own: OwnStateClient;
  meta: TokenMetaMap | null;
  terms: TermsState | null;
  /** Back to the form to change a figure (the typed listing is kept). */
  onEdit: () => void;
  /** The flow is finished or abandoned; `posted` when the listing was
   *  recorded, so the typed form is cleared. */
  onClose: (posted: boolean) => void;
}

/**
 * NFT-01 — an owner lists an NFT for rent. The review is the protocol's own
 * verdict on the listing as a dry run from this wallet, with every term it
 * binds; the single Risk and Terms consent is bound to that read. The wallet
 * is asked to let the protocol move the NFT when it cannot yet (that ERC-721
 * token alone, never the collection; for an ERC-1155 token, the operator
 * approval for this listing only, taken back afterwards whatever happens),
 * the listing is dry-run again with the approval in place, and only then
 * sent. If anything stops it after an approval, the approval is put back
 * (best effort, stated either way). The outcome is measured from the
 * transaction's own logs: the listing recorded, and the NFT moved from the
 * wallet into the owner's own vault.
 */
export function ListForRent({ draft, chain, own, meta, terms, onEdit, onClose }: ListForRentProps) {
  const copy = useCopy();
  const { text, format } = copy;
  const config = useConfig();
  const { mode } = useMode();
  const diamond = chain.diamondAddress;
  const account = own.account;
  const identity = reviewIdentity(own);
  const flowKey = RENT_LIST_KEY;
  const [review, setReview] = useStoredValue<ListReview>(`${flowKey}:review`);
  const [consentFor, setConsentFor] = useStoredValue<number>(`${flowKey}:consent`);
  const [offerId, setOfferId] = useStoredValue<bigint>(`${flowKey}:offer`);
  const [riskOpen, setRiskOpen] = useStoredValue<RiskNeed>(`${flowKey}:risk`);
  const [loadError, setLoadError] = useState<string | null>(null);
  const setStep = useTxNote(flowKey);
  /** The ERC-721 approval this flow made and has not yet seen used or put
   *  back; `since` is the block it mined in. */
  const approvalLeft = useRef<{ token: Hex; tokenId: bigint; prior: Hex | null; since: bigint } | null>(null);
  /** The ERC-1155 operator approval granted for this listing alone, taken
   *  back on every ending by the tracker's release step. */
  const grantLeft = useRef<{ token: Hex; tokenId: bigint; since: bigint } | null>(null);
  const counter = useRef<{ n: number; total: number }>({ n: 0, total: 0 });

  const tokenApproval = (asset: Hex, tokenId: bigint) =>
    nftApproval(
      { own, config, chainId: chain.chainId, diamond, copy, tokenName: format('asset.nft', { asset: assetName(asset, meta), id: String(tokenId) }), setStep },
      asset,
      tokenId,
    );
  const operator = (asset: Hex, tokenId: bigint, say?: (what: string) => void) =>
    operatorApproval(
      { own, config, chainId: chain.chainId, diamond, copy, collection: assetName(asset, meta), setStep: (what) => (what === null || !say ? setStep(what) : say(what)) },
      asset,
      tokenId,
    );

  const tx = useTrackedTx({
    key: flowKey,
    chainId: chain.chainId,
    account,
    sources: own.sources,
    send: async () => {
      if (!review) throw new Error('no listing under review');
      const r = review;
      const d = r.draft;
      counter.current = { n: 0, total: listPromptCount(r) };
      const say = (what: string) => setStep(format('accept.stepOf', { n: String(++counter.current.n), total: String(counter.current.total), what }));
      approvalLeft.current = null;
      grantLeft.current = null;

      // 1. The approval, read again first so a change since the review stops
      //    before any prompt: the one ERC-721 token, or, for an ERC-1155
      //    token, the operator approval for this listing alone.
      let putItBack: (() => Promise<{ sentence: string }>) | null = null;
      if (d.standard === 'erc721') {
        const ap = tokenApproval(d.nft, d.tokenId);
        const now = await ap.read();
        const needed = !(now.approvedForAll || (now.approved !== null && now.approved.toLowerCase() === diamond.toLowerCase()));
        if ((needed ? 1 : 0) !== listApprovalPrompts(r)) throw allowanceMoved(copy);
        if (needed) {
          say(format('nftApproval.step', { token: listedNftName(r, meta, format) }));
          const since = await ap.approve(now.approved);
          approvalLeft.current = { token: d.nft, tokenId: d.tokenId, prior: now.approved, since };
          putItBack = () => ap.putBack(now.approved, since);
        }
      } else {
        const ap = operator(d.nft, d.tokenId, say);
        const now = await ap.read();
        if ((now.approvedForAll ? 0 : 2) !== listApprovalPrompts(r)) throw allowanceMoved(copy);
        if (!now.approvedForAll) {
          say(format('operatorApproval.step', { collection: assetName(d.nft, meta) }));
          const since = await ap.grant();
          grantLeft.current = { token: d.nft, tokenId: d.tokenId, since };
          putItBack = () => {
            grantLeft.current = null;
            return ap.revoke(since);
          };
        }
      }

      const stop = async (reason: string): Promise<never> => {
        if (putItBack === null) throw new StatedRefusal({ code: 'ListingStopped', reason, reopensAt: null, remedy: null });
        approvalLeft.current = null;
        const after = await putItBack();
        throw new StatedRefusal({ code: 'ListingStopped', reason: `${reason} ${after.sentence}`, reopensAt: null, remedy: null });
      };

      // 2. The dry run with the approval in place: the protocol's verdict on
      //    the whole listing, the NFT's move into the vault included.
      const dry = await askThrough(own, (c) => c.simulateContract({ address: diamond, abi: CREATE_ABI, functionName: 'createOffer', args: [r.params], account }));
      if (dry.kind === 'reverted') return stop(format('rentList.dryRunRefused', { reason: listRefusal(dry.error, copy) }));
      if (dry.kind === 'unreadable') return stop(format('flow.unreadable', { reason: dry.reason }));

      // 3. The listing.
      say(text('rentList.stepSend'));
      try {
        return await writeContract(config, { address: diamond, abi: CREATE_ABI, functionName: 'createOffer', args: [r.params], chainId: chain.chainId, account });
      } catch (e) {
        return stop(format('rentList.stoppedAfterApproval', { reason: listRefusal(e, copy) }));
      }
    },
    unwind: async () => {
      const left = approvalLeft.current;
      approvalLeft.current = null;
      if (!left) return null;
      const after = await tokenApproval(left.token, left.tokenId).putBack(left.prior, left.since);
      return cleanUpLeg(after, text('nftApproval.legBack'));
    },
    release: async () => {
      const left = grantLeft.current;
      grantLeft.current = null;
      if (!left) return null;
      const say = (what: string) => setStep(format('accept.stepOf', { n: String(++counter.current.n), total: String(counter.current.total), what }));
      const after = await operator(left.token, left.tokenId, say).revoke(left.since);
      return cleanUpLeg(after, format('operatorApproval.leg', { collection: assetName(left.token, meta) }));
    },
    held: () => (grantLeft.current ? format('operatorApproval.pendingNote', { collection: assetName(grantLeft.current.token, meta) }) : null),
    measure: async (receipt, at) => {
      if (!review) return [];
      const r = review;
      const d = r.draft;
      const legs: LegOutcome[] = [];
      const id = createdOffer(receipt.logs, diamond, account, OFFER_TYPE_LENDER);
      if (id !== null) {
        setOfferId(id);
        legs.push({ status: 'done', label: format('rentList.legListing', { id: id.toString() }) });
      } else {
        legs.push({ status: 'not-done', label: text('rentList.legNoListing'), reason: text('rentList.noListing') });
      }
      const nft = listedNftName(r, meta, format);
      const label = format('rentList.legLocked', { nft });
      let vault: Hex | null = null;
      try {
        vault = await at.read((c, b) => readVault(c, diamond, account, b));
      } catch {
        vault = null;
      }
      if (vault === null) {
        legs.push({ status: 'unknown', label, reason: text('accept.vaultUnknown') });
      } else if (d.standard === 'erc721') {
        // The token's own Transfer log, from this wallet to the vault.
        legs.push(tokenMoved(receipt.logs, d.nft, d.tokenId, account, vault) ? { status: 'done', label } : { status: 'not-done', label, reason: format('rentList.notLocked', { nft }) });
      } else {
        // The token's own TransferSingle / TransferBatch logs, for exactly
        // the quantity, from this wallet to the vault.
        const units = quantityMoved(receipt.logs, d.nft, d.tokenId, account, vault);
        legs.push(
          units === d.quantity
            ? { status: 'done', label }
            : { status: 'not-done', label, reason: format('request.unitsNotLocked', { moved: String(units), expected: String(d.quantity), id: String(d.tokenId) }) },
        );
      }
      return legs;
    },
  });

  const mounted = useMounted();
  const load = async () => {
    try {
      const next = await readListReview(own, diamond, draft, identity);
      if (!mounted.current) return;
      setLoadError(null);
      setReview(next);
    } catch (e) {
      setLoadError(refusalFromError(e).reason);
    }
  };

  // RB-RAILS: read again each block while the review is on screen.
  const onReview = tx.phase.kind === 'review' && review !== null && review.draft === draft;
  useReviewRefresh<ListReview>({
    chainId: chain.chainId,
    active: onReview,
    review,
    read: (before) => readListReview(own, diamond, before.draft, before.identity),
    sameSubject: (a, b) => a.draft === b.draft,
    changed: (before, next) => listChangedBetween(before, next, copy) !== null,
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
      readListReview(own, diamond, draft, identity).then(
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
    let next: ListReview;
    let nowTerms: TermsState;
    try {
      [next, nowTerms] = await Promise.all([readListReview(own, diamond, review.draft, review.identity), own.read((c) => readTerms(c, diamond, account)).then((x) => x.value)]);
    } catch (e) {
      return { kind: 'unreadable', reason: refusalFromError(e).reason };
    }
    if (nowTerms.kind === 'needed') return { kind: 'refused', refusal: { code: 'TermsNotAccepted', reason: text('rentList.termsNewer'), reopensAt: null, remedy: null } };
    const what = listChangedBetween(review, next, copy);
    if (what !== null) {
      if (current()) {
        setReview(next);
        setConsentFor(null);
      }
      return { kind: 'changed', what };
    }
    const blockers = listBlockers(next, meta, copy);
    if (blockers.length > 0) return { kind: 'refused', refusal: { code: 'ListingBlocked', reason: blockers[0]!, reopensAt: null, remedy: null } };
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

  const blockers = review ? listBlockers(review, meta, copy) : [];
  const consented = review !== null && consentFor === review.readAt;
  const termsLink = terms && terms.kind !== 'none' ? termsUrl(terms.version) : `${GUIDE_ORIGIN}/terms`;
  const riskLink = guideUrl(mode, 'rent-list-risks');
  const riskNeed = review ? listRiskNeed(review) : null;
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
            {riskNeed !== null && riskPair !== null && (
              <RiskGate chain={chain} own={own} need={riskNeed} source={{ kind: 'pair', pair: riskPair }} pairLabel={pairLabel} onOpen={() => setRiskOpen(riskNeed)} />
            )}
            <WhyLink summaryKey="rentList.whySummary" detailKey="rentList.why" />
            {blockers.length === 0 && (
              <p className="consent tier-a">
                <label>
                  <input type="checkbox" checked={consented} onChange={(e) => setConsentFor(e.target.checked ? review.readAt : null)} data-testid="rent-list-consent" />
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
                <button type="button" className="btn btn-link" onClick={edit} data-testid="rent-list-edit">
                  {text('rentList.edit')}
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
    <div className="rent-list-flow" data-testid="rent-list-flow">
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
          receipt={review ? listReceipt(review, meta, copy) : null}
          recheck={recheck}
          describeAsset={describeAsset}
          explorer={chain.blockExplorer}
          next={offerId === null ? null : { label: format('rentList.openListing', { id: offerId.toString() }), to: `/offers/${offerId.toString()}` }}
          gate={gate}
          onClose={close}
        />
      )}
    </div>
  );
}
