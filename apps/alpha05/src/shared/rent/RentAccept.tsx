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
import { ACCEPT_DEADLINE_SECONDS, ACCEPT_TERMS_DOMAIN_NAME, ACCEPT_TERMS_DOMAIN_VERSION, ACCEPT_TERMS_TYPES, buildAcceptTerms, freshNonce } from '../offers/acceptTerms';
import { legVerdict, moved, openedLoan } from '../offers/acceptOutcome';
import { offerAmount } from '../offers/offerLine';
import { readVault } from '../offers/reads';
import { exactTokenAmount, tokenAmount, type TokenMetaMap } from '../reads/tokens';
import { needFromAcceptCode, type RiskNeed } from '../risk/riskAccess';
import { RiskGate, RiskStepFlow } from '../risk/RiskAccessStep';
import { readTerms, termsUrl, type TermsState } from '../terms/terms';
import type { AnchoredReader } from '../tx/anchored';
import { allowanceSteps } from '../tx/approval';
import { allowanceMoved, approvalFlow } from '../tx/approvalFlow';
import { cleanUpLeg } from '../tx/cleanUp';
import type { LegOutcome } from '../tx/outcome';
import { askThrough } from '../tx/simulate';
import { useStoredValue, useTxNote } from '../tx/txStore';
import { useMounted, useReviewRefresh } from '../tx/useReviewRefresh';
import { useTrackedTx } from '../tx/useTrackedTx';
import { ActionFlow, reviewIdentity, type Recheck } from '../ui/ActionFlow';
import { formatUtc, shortAddress } from '../ui/format';
import { Notice } from '../ui/Notice';
import { readRentalUse } from './rentReads';
import { rentReceipt } from './rentReceipt';
import { promptCount, readRentReview, rentBlockers, rentChangedBetween, reviewCost, type RentReview } from './rentReview';

type Hex = `0x${string}`;

const ACCEPT_ABI = OfferAcceptFacetABI as Abi;
/** `LibVaipakam.AssetType.ERC1155`, by enum position. */
const ASSET_ERC1155 = 2;

/** The store key a rental from the offer page keeps its state under; its
 *  own, so a loan acceptance in flight never shares a review with it. */
export const RENT_KEY = 'offers.rent';

interface RentAcceptProps {
  offerId: bigint;
  chain: SupportedChain;
  own: OwnStateClient;
  meta: TokenMetaMap | null;
  terms: TermsState | null;
  onClose: () => void;
}

/**
 * NFT-02 / NFT-04 — a renter rents an NFT an owner listed. The review is
 * built from the listing as stored, the protocol's preview for this wallet
 * and its published up-front rule; the single Risk and Terms consent is
 * bound to the figures shown (a re-read that moves any of them clears it).
 * The wallet signs the exact terms, approves exactly the rent and buffer when
 * needed, and the rental is sent only after a dry run with that signature
 * passes; anything that stops it after an approval puts the approval back
 * (best effort, stated either way). The outcome is measured from the
 * transaction's own logs and the owner's vault at its block: the rental it
 * started, what moved into the renter's vault, and that the vault names the
 * renter as the NFT's user.
 */
export function RentAccept({ offerId, chain, own, meta, terms, onClose }: RentAcceptProps) {
  const copy = useCopy();
  const { text, format } = copy;
  const config = useConfig();
  const { mode } = useMode();
  const diamond = chain.diamondAddress;
  const account = own.account;
  const identity = reviewIdentity(own);
  const flowKey = RENT_KEY;
  const [review, setReview] = useStoredValue<RentReview>(`${flowKey}:review`);
  const [consentFor, setConsentFor] = useStoredValue<number>(`${flowKey}:consent`);
  const [loanId, setLoanId] = useStoredValue<bigint>(`${flowKey}:loan`);
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
      if (!review) throw new Error('no rental under review');
      const r = review;
      const total = promptCount(r);
      let n = 0;
      const say = (what: string) => setStep(format('accept.stepOf', { n: String(++n), total: String(total), what }));
      const pay = r.offer.prepayAsset;
      const need = reviewCost(r).total;
      approvalLeft.current = null;

      const io = allowanceIo(pay, (amount, i, of) => say(of === 2 && i === 0 ? text('approval.stepZero') : format('approval.step', { amount: exact(pay, amount) })));
      const prior = await readAllowance(pay);
      const steps = prior < need ? await allowanceSteps(io, prior, need) : [];
      const approved = steps.length > 0;
      if (steps.length !== r.approvalSteps) throw allowanceMoved(copy);

      // 1. The signed terms, from the listing as stored. No chain effect.
      //    The NFT is unpriced, so the signature names it as the illiquid
      //    leg the review showed; a rental has no collateral leg.
      const block = await own.read((c) => c.getBlock({ blockTag: 'latest' }));
      const message = buildAcceptTerms(r.offer, {
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

      // 2. The approval, for exactly the rent and buffer, when needed.
      let since: bigint | null = null;
      if (approved) {
        since = await approveExactly(io, pay, need, prior);
        approvalLeft.current = { token: pay, prior, amount: need, since };
      }

      const stop = async (reason: string): Promise<never> => {
        if (!approved) throw new StatedRefusal({ code: 'AcceptStopped', reason, reopensAt: null, remedy: null });
        approvalLeft.current = null;
        const after = await putBack(pay, prior, need, since);
        throw new StatedRefusal({ code: 'AcceptStopped', reason: `${reason} ${after.sentence}`, reopensAt: null, remedy: null });
      };

      // 3. The dry run with the real signature: the protocol's own verdict.
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
      const after = await putBack(left.token, left.prior, left.amount, left.since);
      return cleanUpLeg(after, format('approval.legBack', { amount: exact(left.token, left.prior) }));
    },
    measure: async (receipt, at) => (review ? measureRenter(review, receipt.logs, at) : []),
  });

  /** The rental, the rent and buffer moved into the renter's vault, and the
   *  owner's vault naming the renter as the NFT's user at the receipt's block. */
  const measureRenter = async (r: RentReview, logs: readonly Log[], at: AnchoredReader): Promise<LegOutcome[]> => {
    const o = r.offer;
    const legs: LegOutcome[] = [];
    const opened = openedLoan(logs, diamond, offerId, account);
    if (opened) {
      setLoanId(opened.loanId);
      legs.push({ status: 'done', label: format('rent.legRental', { id: opened.loanId.toString() }) });
    } else {
      legs.push({ status: 'not-done', label: format('rent.legNoRental', { id: offerId.toString() }), reason: text('rent.noRental') });
    }
    const pay = o.prepayAsset;
    const need = reviewCost(r).total;
    const payLabel = format('rent.legPrepaid', { amount: amt(pay, need) });
    let vault: Hex | null = null;
    try {
      vault = await at.read((c, b) => readVault(c, diamond, account, b));
    } catch {
      vault = null;
    }
    if (vault === null) {
      legs.push({ status: 'unknown', label: payLabel, reason: text('accept.vaultUnknown') });
    } else {
      const got = moved(logs, pay, account, vault);
      const v = legVerdict(got, need);
      legs.push(v === 'done' ? { status: 'done', label: payLabel } : { status: v, label: payLabel, reason: format('rent.prepaidOther', { amount: exact(pay, got), expected: exact(pay, need) }) });
    }
    // The user right, read from the owner's vault at the receipt's block. An
    // ERC-721 has one user; an ERC-1155 rents by quantity, so its count of
    // units rented out must have grown by this rental's quantity.
    const nft = offerAmount(o, o.amount, meta, format);
    try {
      if (o.assetType === ASSET_ERC1155) {
        const [before, after] = await Promise.all([
          at.read((c, b) => readRentalUse(c, diamond, o.creator, o.lendingAsset, o.tokenId, { blockNumber: b.blockNumber - 1n })),
          at.read((c, b) => readRentalUse(c, diamond, o.creator, o.lendingAsset, o.tokenId, b)),
        ]);
        const label = format('rent.useMulti', { nft, quantity: after.quantity.toString() });
        legs.push(after.quantity >= before.quantity + o.quantity ? { status: 'done', label } : { status: 'unknown', label, reason: text('rent.useMultiOther') });
      } else {
        const use = await at.read((c, b) => readRentalUse(c, diamond, o.creator, o.lendingAsset, o.tokenId, b));
        const mine = use.user.toLowerCase() === account.toLowerCase();
        const label = format('rent.legUse', { nft, until: use.expires > 0n ? formatUtc(Number(use.expires)) : text('receipt.unknown') });
        legs.push(mine ? { status: 'done', label } : { status: opened ? 'unknown' : 'not-done', label, reason: text('rent.useOther') });
      }
    } catch (e) {
      legs.push({ status: 'unknown', label: format('rent.legUse', { nft, until: text('receipt.unknown') }), reason: refusalFromError(e).reason });
    }
    return legs;
  };

  const mounted = useMounted();
  const load = async () => {
    try {
      const next = await readRentReview(own, diamond, offerId, identity);
      if (!mounted.current) return;
      setLoadError(null);
      setReview(next);
    } catch (e) {
      setLoadError(refusalFromError(e).reason);
    }
  };

  const reviewOpened = useRef<bigint | null>(null);
  const onReview = tx.phase.kind === 'review' && review !== null && review.offerId === offerId;
  useReviewRefresh<RentReview>({
    chainId: chain.chainId,
    active: onReview,
    review,
    read: (before) => readRentReview(own, diamond, before.offerId, before.identity),
    sameSubject: (a, b) => a.offerId === b.offerId,
    changed: (before, next) => rentChangedBetween(before, next, copy) !== null,
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
      readRentReview(own, diamond, offerId, identity).then(
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
    // Opened once per listing; the tracker and the stored review carry the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offerId]);

  const recheck = async (current: () => boolean): Promise<Recheck> => {
    if (!review) return { kind: 'unreadable', reason: text('flow.reading') };
    let next: RentReview;
    let nowTerms: TermsState;
    try {
      [next, nowTerms] = await Promise.all([readRentReview(own, diamond, offerId, review.identity), own.read((c) => readTerms(c, diamond, account)).then((r) => r.value)]);
    } catch (e) {
      return { kind: 'unreadable', reason: refusalFromError(e).reason };
    }
    if (nowTerms.kind === 'needed') return { kind: 'refused', refusal: { code: 'TermsNotAccepted', reason: text('accept.termsNewer'), reopensAt: null, remedy: null } };
    const what = rentChangedBetween(review, next, copy);
    if (what !== null) {
      if (current()) {
        setReview(next);
        setConsentFor(null);
      }
      return { kind: 'changed', what };
    }
    const blockers = rentBlockers(next, meta, copy);
    if (blockers.length > 0) return { kind: 'refused', refusal: { code: 'AcceptBlocked', reason: blockers[0]!, reopensAt: null, remedy: null } };
    return { kind: 'ok' };
  };

  const blockers = review ? rentBlockers(review, meta, copy) : [];
  const consented = review !== null && consentFor === review.readAt;
  const termsLink = terms && terms.kind !== 'none' ? termsUrl(terms.version) : `${GUIDE_ORIGIN}/terms`;
  const riskLink = guideUrl(mode, 'rent-risks');
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
            <WhyLink summaryKey="accept.signSummary" detailKey="rent.signWhy" />
            {blockers.length === 0 && (
              <p className="consent tier-a">
                <label>
                  <input type="checkbox" checked={consented} onChange={(e) => setConsentFor(e.target.checked ? review.readAt : null)} data-testid="rent-consent" />
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
    <div className="accept-offer rent-accept" data-offer-id={offerId.toString()} data-testid="rent-accept">
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
          receipt={review ? rentReceipt(review, meta, copy) : null}
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
