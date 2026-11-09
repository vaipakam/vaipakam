import { useEffect, useRef, useState } from 'react';
import type { Abi, Log } from 'viem';
import { useConfig } from 'wagmi';
import { signTypedData, writeContract } from 'wagmi/actions';
import { OfferAcceptFacetABI } from '@vaipakam/contracts/abis';
import type { OwnStateClient } from '../../chain/ownRail';
import type { SupportedChain } from '../../chain/chains';
import { useMode } from '../../app/ModeContext';
import { useCopy } from '../copy/useCopy';
import { refusalFromError, StatedRefusal } from '../eligibility/refusal';
import { WhyLink } from '../help/WhyLink';
import { GUIDE_ORIGIN, guideUrl } from '../help/guide';
import { quantityMoved, tokenMoved } from '../nft/nft';
import { ACCEPT_DEADLINE_SECONDS, ACCEPT_TERMS_DOMAIN_NAME, ACCEPT_TERMS_DOMAIN_VERSION, ACCEPT_TERMS_TYPES, buildAcceptTerms, freshNonce } from '../offers/acceptTerms';
import { openedLoan } from '../offers/acceptOutcome';
import { offerAmount } from '../offers/offerLine';
import { readVault } from '../offers/reads';
import { assetName, type TokenMetaMap } from '../reads/tokens';
import { needFromAcceptCode, type RiskNeed } from '../risk/riskAccess';
import { RiskGate, RiskStepFlow } from '../risk/RiskAccessStep';
import { readTerms, termsUrl, type TermsState } from '../terms/terms';
import type { AnchoredReader } from '../tx/anchored';
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
import { formatUtc, shortAddress } from '../ui/format';
import { Notice } from '../ui/Notice';
import { readRentalUse } from './rentReads';
import { takeReceipt } from './takeReceipt';
import { readTakeReview, takeApprovalPrompts, takeBlockers, takeChangedBetween, takePromptCount, type TakeReview } from './takeReview';

type Hex = `0x${string}`;

const ACCEPT_ABI = OfferAcceptFacetABI as Abi;

/** The store key taking a renter's request from the offer page keeps its
 *  state under; its own, so a rental or a loan in flight never shares a
 *  review with it. */
export const TAKE_REQUEST_KEY = 'offers.takeRequest';

interface TakeRequestProps {
  offerId: bigint;
  chain: SupportedChain;
  own: OwnStateClient;
  meta: TokenMetaMap | null;
  terms: TermsState | null;
  onClose: () => void;
}

/**
 * NFT-01 / NFT-02 — an owner takes a renter's request for an NFT the owner
 * holds. The review is built from the request as stored, the protocol's
 * preview for this wallet and who holds the NFT now; the single Risk and
 * Terms consent is bound to the figures shown (a re-read that moves any of
 * them clears it). The wallet signs the exact terms, lets the protocol move
 * the NFT when it cannot yet (that ERC-721 token alone; for an ERC-1155
 * token, the operator approval for this rental only, taken back afterwards
 * whatever happens), and the acceptance is sent only after a dry run with
 * that signature passes; anything that stops it after an approval puts the
 * approval back (best effort, stated either way). The outcome is measured
 * from the transaction's own logs and the owner's vault at its block: the
 * rental it started, the NFT moved into the owner's own vault, and that the
 * vault names the renter as the NFT's user.
 */
export function TakeRequest({ offerId, chain, own, meta, terms, onClose }: TakeRequestProps) {
  const copy = useCopy();
  const { text, format } = copy;
  const config = useConfig();
  const { mode } = useMode();
  const diamond = chain.diamondAddress;
  const account = own.account;
  const identity = reviewIdentity(own);
  const flowKey = TAKE_REQUEST_KEY;
  const [review, setReview] = useStoredValue<TakeReview>(`${flowKey}:review`);
  const [consentFor, setConsentFor] = useStoredValue<number>(`${flowKey}:consent`);
  const [loanId, setLoanId] = useStoredValue<bigint>(`${flowKey}:loan`);
  const [riskOpen, setRiskOpen] = useStoredValue<RiskNeed>(`${flowKey}:risk`);
  const [loadError, setLoadError] = useState<string | null>(null);
  const setStep = useTxNote(flowKey);
  /** The ERC-721 approval this flow made and has not yet seen used or put
   *  back; `since` is the block it mined in. */
  const approvalLeft = useRef<{ token: Hex; tokenId: bigint; prior: Hex | null; since: bigint } | null>(null);
  /** The ERC-1155 operator approval granted for this rental alone, taken
   *  back on every ending by the tracker's release step. */
  const grantLeft = useRef<{ token: Hex; tokenId: bigint; since: bigint } | null>(null);
  const counter = useRef<{ n: number; total: number }>({ n: 0, total: 0 });

  const nftName = (r: TakeReview) => offerAmount(r.offer, r.offer.amount, meta, format);
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
      if (!review) throw new Error('no request under review');
      const r = review;
      const o = r.offer;
      counter.current = { n: 0, total: takePromptCount(r) };
      const say = (what: string) => setStep(format('accept.stepOf', { n: String(++counter.current.n), total: String(counter.current.total), what }));
      approvalLeft.current = null;
      grantLeft.current = null;
      const multi = r.holding.kind === 'erc1155';

      // The approval state, read again first so a change since the review
      // stops before any prompt.
      const ap721 = multi ? null : tokenApproval(o.lendingAsset, o.tokenId);
      const ap1155 = multi ? operator(o.lendingAsset, o.tokenId, say) : null;
      const now721 = ap721 ? await ap721.read() : null;
      const now1155 = ap1155 ? await ap1155.read() : null;
      const needed = now721 ? !(now721.approvedForAll || (now721.approved !== null && now721.approved.toLowerCase() === diamond.toLowerCase())) : !now1155!.approvedForAll;
      if ((needed ? (multi ? 2 : 1) : 0) !== takeApprovalPrompts(r)) throw allowanceMoved(copy);

      // 1. The signed terms, from the request as stored. No chain effect.
      //    The NFT is unpriced, so the signature names it as the illiquid
      //    leg the review showed; a rental has no collateral leg.
      const block = await own.read((c) => c.getBlock({ blockTag: 'latest' }));
      const message = buildAcceptTerms(o, {
        acceptor: account,
        linkedLoanId: r.linkedLoanId,
        riskTermsHash: r.riskTermsHash,
        nonce: freshNonce(),
        deadline: block.value.timestamp + BigInt(ACCEPT_DEADLINE_SECONDS),
        illiquidLending: r.nftClass === 'illiquid',
        illiquidCollateral: false,
      });
      say(text('accept.stepSign'));
      const signature = await signTypedData(config, {
        account,
        domain: { name: ACCEPT_TERMS_DOMAIN_NAME, version: ACCEPT_TERMS_DOMAIN_VERSION, chainId: chain.chainId, verifyingContract: diamond },
        types: ACCEPT_TERMS_TYPES,
        primaryType: 'AcceptTerms',
        message,
      });

      // 2. The approval: the one ERC-721 token, or for an ERC-1155 token the
      //    operator approval for this rental alone.
      let putItBack: (() => Promise<{ sentence: string }>) | null = null;
      if (needed && ap721 && now721) {
        say(format('nftApproval.step', { token: nftName(r) }));
        const since = await ap721.approve(now721.approved);
        approvalLeft.current = { token: o.lendingAsset, tokenId: o.tokenId, prior: now721.approved, since };
        putItBack = () => ap721.putBack(now721.approved, since);
      } else if (needed && ap1155) {
        say(format('operatorApproval.step', { collection: assetName(o.lendingAsset, meta) }));
        const since = await ap1155.grant();
        grantLeft.current = { token: o.lendingAsset, tokenId: o.tokenId, since };
        putItBack = () => {
          grantLeft.current = null;
          return ap1155.revoke(since);
        };
      }

      const stop = async (reason: string): Promise<never> => {
        if (putItBack === null) throw new StatedRefusal({ code: 'TakeStopped', reason, reopensAt: null, remedy: null });
        approvalLeft.current = null;
        const after = await putItBack();
        throw new StatedRefusal({ code: 'TakeStopped', reason: `${reason} ${after.sentence}`, reopensAt: null, remedy: null });
      };

      // 3. The dry run with the real signature and the approval in place:
      //    the protocol's own verdict, the NFT's move included.
      const dry = await askThrough(own, (c) => c.simulateContract({ address: diamond, abi: ACCEPT_ABI, functionName: 'acceptOffer', args: [offerId, message, signature], account }));
      if (dry.kind === 'reverted') return stop(format('accept.dryRunRefused', { reason: refusalFromError(dry.error).reason }));
      if (dry.kind === 'unreadable') return stop(format('flow.unreadable', { reason: dry.reason }));

      // 4. The rental.
      say(text('rent.stepSend'));
      try {
        return await writeContract(config, { address: diamond, abi: ACCEPT_ABI, functionName: 'acceptOffer', args: [offerId, message, signature], chainId: chain.chainId, account });
      } catch (e) {
        return stop(format('accept.stoppedAfterApproval', { reason: refusalFromError(e).reason }));
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
    measure: async (receipt, at) => (review ? measureOwner(review, receipt.logs, at) : []),
  });

  /** The rental, the NFT moved into the owner's vault, and the vault naming
   *  the renter as the NFT's user at the receipt's block. */
  const measureOwner = async (r: TakeReview, logs: readonly Log[], at: AnchoredReader): Promise<LegOutcome[]> => {
    const o = r.offer;
    const legs: LegOutcome[] = [];
    const opened = openedLoan(logs, diamond, offerId, o.creator);
    if (opened) {
      setLoanId(opened.loanId);
      legs.push({ status: 'done', label: format('rentTake.legRental', { id: opened.loanId.toString() }) });
    } else {
      legs.push({ status: 'not-done', label: format('rentTake.legNoRental', { id: offerId.toString() }), reason: text('rentTake.noRental') });
    }
    const nft = nftName(r);
    const label = format('rentList.legLocked', { nft });
    let vault: Hex | null = null;
    try {
      vault = await at.read((c, b) => readVault(c, diamond, account, b));
    } catch {
      vault = null;
    }
    if (vault === null) {
      legs.push({ status: 'unknown', label, reason: text('accept.vaultUnknown') });
    } else if (r.holding.kind === 'erc721') {
      legs.push(tokenMoved(logs, o.lendingAsset, o.tokenId, account, vault) ? { status: 'done', label } : { status: 'not-done', label, reason: format('rentList.notLocked', { nft }) });
    } else {
      const units = quantityMoved(logs, o.lendingAsset, o.tokenId, account, vault);
      legs.push(
        units === o.quantity
          ? { status: 'done', label }
          : { status: 'not-done', label, reason: format('request.unitsNotLocked', { moved: String(units), expected: String(o.quantity), id: String(o.tokenId) }) },
      );
    }
    // The user right, read from this owner's vault at the receipt's block.
    try {
      if (r.holding.kind === 'erc1155') {
        const [before, after] = await Promise.all([
          at.read((c, b) => readRentalUse(c, diamond, account, o.lendingAsset, o.tokenId, { blockNumber: b.blockNumber - 1n })),
          at.read((c, b) => readRentalUse(c, diamond, account, o.lendingAsset, o.tokenId, b)),
        ]);
        const useLabel = format('rentTake.useMulti', { nft, quantity: after.quantity.toString() });
        legs.push(after.quantity >= before.quantity + o.quantity ? { status: 'done', label: useLabel } : { status: 'unknown', label: useLabel, reason: text('rent.useMultiOther') });
      } else {
        const use = await at.read((c, b) => readRentalUse(c, diamond, account, o.lendingAsset, o.tokenId, b));
        const theirs = use.user.toLowerCase() === o.creator.toLowerCase();
        const useLabel = format('rentTake.legUse', { nft, until: use.expires > 0n ? formatUtc(Number(use.expires)) : text('receipt.unknown') });
        legs.push(theirs ? { status: 'done', label: useLabel } : { status: opened ? 'unknown' : 'not-done', label: useLabel, reason: text('rentTake.useOther') });
      }
    } catch (e) {
      legs.push({ status: 'unknown', label: format('rentTake.legUse', { nft, until: text('receipt.unknown') }), reason: refusalFromError(e).reason });
    }
    return legs;
  };

  const mounted = useMounted();
  const load = async () => {
    try {
      const next = await readTakeReview(own, diamond, offerId, identity);
      if (!mounted.current) return;
      setLoadError(null);
      setReview(next);
    } catch (e) {
      setLoadError(refusalFromError(e).reason);
    }
  };

  const reviewOpened = useRef<bigint | null>(null);
  const onReview = tx.phase.kind === 'review' && review !== null && review.offerId === offerId;
  useReviewRefresh<TakeReview>({
    chainId: chain.chainId,
    active: onReview,
    review,
    read: (before) => readTakeReview(own, diamond, before.offerId, before.identity),
    sameSubject: (a, b) => a.offerId === b.offerId,
    changed: (before, next) => takeChangedBetween(before, next, copy) !== null,
    setReview,
    onChanged: () => setConsentFor(null),
  });

  useEffect(() => {
    const open = tx.phase.kind === 'idle' || tx.phase.kind === 'review';
    if (!open) return;
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
      readTakeReview(own, diamond, offerId, identity).then(
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
    // Opened once per request; the tracker and the stored review carry the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offerId]);

  const recheck = async (current: () => boolean): Promise<Recheck> => {
    if (!review) return { kind: 'unreadable', reason: text('flow.reading') };
    let next: TakeReview;
    let nowTerms: TermsState;
    try {
      [next, nowTerms] = await Promise.all([readTakeReview(own, diamond, offerId, review.identity), own.read((c) => readTerms(c, diamond, account)).then((x) => x.value)]);
    } catch (e) {
      return { kind: 'unreadable', reason: refusalFromError(e).reason };
    }
    if (nowTerms.kind === 'needed') return { kind: 'refused', refusal: { code: 'TermsNotAccepted', reason: text('accept.termsNewer'), reopensAt: null, remedy: null } };
    const what = takeChangedBetween(review, next, copy);
    if (what !== null) {
      if (current()) {
        setReview(next);
        setConsentFor(null);
      }
      return { kind: 'changed', what };
    }
    const blockers = takeBlockers(next, meta, copy);
    if (blockers.length > 0) return { kind: 'refused', refusal: { code: 'TakeBlocked', reason: blockers[0]!, reopensAt: null, remedy: null } };
    return { kind: 'ok' };
  };

  const blockers = review ? takeBlockers(review, meta, copy) : [];
  const consented = review !== null && consentFor === review.readAt;
  const termsLink = terms && terms.kind !== 'none' ? termsUrl(terms.version) : `${GUIDE_ORIGIN}/terms`;
  const riskLink = guideUrl(mode, 'rent-take-risks');
  const riskNeed = review !== null && review.creatorGate === 0 ? needFromAcceptCode(review.gate) : null;
  const symbol = (a: Hex) => meta?.[a.toLowerCase()]?.symbol ?? shortAddress(a);
  const pairLabel = review ? format('rent.pairName', { nft: symbol(review.offer.lendingAsset), pay: symbol(review.offer.prepayAsset) }) : '';

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
            <WhyLink summaryKey="accept.signSummary" detailKey="rentTake.signWhy" />
            {blockers.length === 0 && (
              <p className="consent tier-a">
                <label>
                  <input type="checkbox" checked={consented} onChange={(e) => setConsentFor(e.target.checked ? review.readAt : null)} data-testid="rent-take-consent" />
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
    <div className="accept-offer rent-take" data-offer-id={offerId.toString()} data-testid="rent-take">
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
          publicQueue
          identity={identity}
          reviewedFor={review?.identity ?? tx.frozen?.identity ?? identity}
          receipt={review ? takeReceipt(review, meta, copy) : null}
          recheck={recheck}
          describeAsset={describeAsset}
          explorer={chain.blockExplorer}
          next={loanId !== null ? { label: format('rent.openRental', { id: loanId.toString() }), to: `/positions/${loanId.toString()}` } : null}
          gate={gate}
          onClose={close}
        />
      )}
    </div>
  );
}
