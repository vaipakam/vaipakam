/**
 * NFT-01 / NFT-02 — what an owner's review of taking a renter's request
 * stands on, read in one go through the wallet's connection: the request as
 * stored and its state, the protocol's preview for this wallet, who holds
 * the named NFT now and whether the protocol may move it, the payment and
 * NFT classes, the buffer share the request recorded, the grace period and
 * the protocol's share as they stand today, and the risk-access gates for
 * this offer. Taking the request moves the owner's NFT into the owner's own
 * vault and starts the rental at once: the renter's rent and buffer are
 * already in the renter's vault.
 *
 * A rental carries no collateral and no health factor, so none is read; the
 * risk-access check is the protocol's own for this offer, which judges a
 * rental on its payment token alone.
 */
import type { OwnStateClient } from '../../chain/ownRail';
import type { CopyAccess, CopyKey } from '../copy/useCopy';
import { SWITCH_EFFECTS } from '../eligibility/switchClasses';
import { diamondMayMove, holds, readErc721, readErc1155, type Erc721State, type Erc1155State } from '../nft/nft';
import { readAssetClass, type AssetClass } from '../offers/assets';
import { OFFER_BORROWER, type StoredOffer } from '../offers/acceptTerms';
import { ASSET_ERC1155 } from '../post/postModel';
import { gateBlock } from '../offers/model';
import {
  readAcceptGate,
  readCreatorGate,
  readGraceSeconds,
  readLinkedLoanId,
  readOffer,
  readOfferState,
  readPreview,
  readRiskTermsHash,
  readTreasuryFeeBps,
  readVault,
  type AcceptPreview,
  type OfferState,
  statedAcceptError,
} from '../offers/reads';
import type { TokenMetaMap } from '../reads/tokens';
import { shortAddress } from '../ui/format';
import { isRental, rentalCost, type RentalCost } from './rental';
import { readListingBufferBps, readTodayBufferBps } from './rentReads';

type Hex = `0x${string}`;

/** A renter's request: a rental posted by the renter, with the rent and
 *  buffer already in the renter's vault, which an owner takes here. */
export function isRentRequest(o: Pick<StoredOffer, 'assetType' | 'offerType'>): boolean {
  return isRental(o) && o.offerType === OFFER_BORROWER;
}

/** The NFT as the owner's wallet and the protocol stand on it. */
export type TakeHolding = { kind: 'erc721'; state: Erc721State } | { kind: 'erc1155'; state: Erc1155State };

export interface TakeReview {
  /** The wallet and network the review was read under (RB-REVIEW). */
  identity: string;
  account: Hex;
  diamond: Hex;
  offerId: bigint;
  offer: StoredOffer;
  state: OfferState;
  preview: AcceptPreview;
  linkedLoanId: bigint;
  riskTermsHash: Hex;
  holding: TakeHolding;
  nftClass: AssetClass;
  prepayClass: AssetClass;
  graceSeconds: bigint;
  /** The buffer share the request recorded (0: none recorded). */
  requestBufferBps: bigint;
  /** The protocol's buffer setting now. */
  todayBufferBps: bigint;
  /** The protocol's share of the rent now (bps), which the rental fixes
   *  when it starts; null when it could not be read. */
  protocolShareBps: bigint | null;
  /** This wallet's vault; the zero address when taking the request opens it. */
  vault: Hex;
  gate: number;
  creatorGate: number;
  readAt: number;
}

export class NotARequest extends Error {
  readonly offerId: bigint;
  constructor(offerId: bigint) {
    super(`offer #${offerId.toString()} is not a request to rent an NFT`);
    this.offerId = offerId;
  }
}

/** What the rental draws from the renter's vault over its term, from the
 *  review's figures: the request's daily fee (the preview reports it as the
 *  amount) for its term, and the buffer the request recorded. */
export function takeCost(r: Pick<TakeReview, 'preview' | 'offer' | 'requestBufferBps' | 'todayBufferBps'>): RentalCost {
  return rentalCost(r.preview.effectivePrincipal, r.offer.durationDays, r.requestBufferBps, r.todayBufferBps);
}

export async function readTakeReview(own: OwnStateClient, diamond: Hex, offerId: bigint, identity: string): Promise<TakeReview> {
  const account = own.account;
  const r = <T>(fn: Parameters<OwnStateClient['read']>[0]) => own.read(fn).then((x) => x.value as T);
  const offer = await r<StoredOffer>((c) => readOffer(c, diamond, offerId));
  if (!isRentRequest(offer)) throw new NotARequest(offerId);
  const multi = offer.assetType === ASSET_ERC1155;
  const [state, preview, linkedLoanId, riskTermsHash, held, nftClass, prepayClass, graceSeconds, requestBufferBps, todayBufferBps, protocolShareBps, vault, gate, creatorGate] =
    await Promise.all([
      r<OfferState>((c) => readOfferState(c, diamond, offerId)),
      r<AcceptPreview>((c) => readPreview(c, diamond, offerId, account)),
      r<bigint>((c) => readLinkedLoanId(c, diamond, offerId)),
      r<Hex>((c) => readRiskTermsHash(c, diamond)),
      multi
        ? r<Erc1155State>((c) => readErc1155(c, offer.lendingAsset, offer.tokenId, account, diamond))
        : r<Erc721State>((c) => readErc721(c, offer.lendingAsset, offer.tokenId, account, diamond)),
      r<AssetClass>((c) => readAssetClass(c, diamond, offer.lendingAsset)),
      r<AssetClass>((c) => readAssetClass(c, diamond, offer.prepayAsset)),
      r<bigint>((c) => readGraceSeconds(c, diamond, offer.durationDays)),
      r<bigint>((c) => readListingBufferBps(c, diamond, offerId)),
      r<bigint>((c) => readTodayBufferBps(c, diamond)),
      // Today's share: stated as such, so a failed read is said, not guessed.
      r<bigint>((c) => readTreasuryFeeBps(c, diamond)).catch(() => null),
      r<Hex>((c) => readVault(c, diamond, account)),
      r<number>((c) => readAcceptGate(c, diamond, offerId, account)),
      r<number>((c) => readCreatorGate(c, diamond, offerId)),
    ]);
  const holding: TakeHolding = multi ? { kind: 'erc1155', state: held as Erc1155State } : { kind: 'erc721', state: held as Erc721State };
  return {
    identity,
    account,
    diamond,
    offerId,
    offer,
    state,
    preview,
    linkedLoanId,
    riskTermsHash,
    holding,
    nftClass,
    prepayClass,
    graceSeconds,
    requestBufferBps,
    todayBufferBps,
    protocolShareBps: protocolShareBps as bigint | null,
    vault,
    gate,
    creatorGate,
    readAt: Date.now(),
  };
}

/** Whether the protocol still needs the wallet's approval to move the NFT. */
export function takeNeedsApproval(r: Pick<TakeReview, 'holding' | 'diamond'>): boolean {
  const h = r.holding;
  return h.kind === 'erc721' ? !diamondMayMove(h.state, r.diamond) : !h.state.approvedForAll;
}

/** The approval's wallet prompts: one for an ERC-721 token (that token
 *  alone); two for an ERC-1155 collection (the operator approval, and taking
 *  it back once the rental starts). */
export function takeApprovalPrompts(r: Pick<TakeReview, 'holding' | 'diamond'>): number {
  if (!takeNeedsApproval(r)) return 0;
  return r.holding.kind === 'erc721' ? 1 : 2;
}

/** The signed terms, the approval steps, and the acceptance. */
export function takePromptCount(r: Pick<TakeReview, 'holding' | 'diamond'>): number {
  return 2 + takeApprovalPrompts(r);
}

/** What the wallet lacks of the NFT the request names. */
export type TakeLack = { kind: 'none' } | { kind: 'no-token' } | { kind: 'not-held' } | { kind: 'units'; missing: bigint };

export function takeLack(r: Pick<TakeReview, 'holding' | 'account' | 'offer'>): TakeLack {
  const h = r.holding;
  if (h.kind === 'erc721') return h.state.owner === null ? { kind: 'no-token' } : holds(h.state, r.account) ? { kind: 'none' } : { kind: 'not-held' };
  return h.state.balance < r.offer.quantity ? { kind: 'units', missing: r.offer.quantity - h.state.balance } : { kind: 'none' };
}

const STATE_KEYS: Readonly<Record<Exclude<OfferState, 'open'>, CopyKey>> = {
  accepted: 'rentTake.stateAccepted',
  cancelled: 'rentTake.stateCancelled',
  expired: 'rentTake.stateExpired',
  'sale-consumed': 'borrow.stateSaleConsumed',
};

/** The refusals whose wording names the other side, as an owner reads them;
 *  every other refusal reads the same as a loan's. */
const TAKE_ERRORS: Partial<Record<AcceptPreview['error'], CopyKey>> = {
  OfferAlreadyAccepted: 'rentTake.err.OfferAlreadyAccepted',
  SanctionedAcceptor: 'rentTake.err.SanctionedAcceptor',
  SanctionedCreator: 'rentTake.err.SanctionedCreator',
  AssetPaused: 'rent.err.AssetPaused',
  RiskAndTermsConsentRequired: 'rentTake.err.RiskAndTermsConsentRequired',
  OfferExpired: 'rentTake.err.OfferExpired',
  OfferIsCancelled: 'rentTake.err.OfferIsCancelled',
  SelfTrade: 'rentTake.err.SelfTrade',
  Unrecognised: 'rentTake.err.Unrecognised',
};

const GATE_KEYS: Readonly<Record<number, CopyKey>> = { 1: 'risk.blockTier', 2: 'risk.blockConsent', 3: 'risk.blockAck', 4: 'risk.blockConsent' };

/** The protocol's first refusal of taking this request, as an owner reads it. */
export function takeErrorText(code: AcceptPreview['error'], copy: Pick<CopyAccess, 'text' | 'format'>): string {
  const error = statedAcceptError(code);
  if (error === 'None') return '';
  if (error === 'ProtocolPaused') return copy.format('rent.err.ProtocolPaused', { staysOpen: SWITCH_EFFECTS['2'].staysOpen });
  return copy.text(TAKE_ERRORS[error] ?? (`accept.err.${error}` as CopyKey));
}

/**
 * Every reason the wallet must not open for this request, in the order the
 * owner should meet them; empty when the protocol reports nothing and the
 * wallet holds the NFT.
 */
export function takeBlockers(r: TakeReview, meta: TokenMetaMap | null, copy: Pick<CopyAccess, 'text' | 'format'>): string[] {
  const out: string[] = [];
  if (r.state !== 'open') out.push(copy.format('rentTake.blockState', { state: copy.text(STATE_KEYS[r.state]) }));
  else if (r.preview.error !== 'None') out.push(takeErrorText(r.preview.error, copy));
  // A rental is never tied to a running loan; one that says it is is not a
  // request this review describes.
  if (r.linkedLoanId !== 0n) out.push(copy.format('rentTake.blockLinked', { id: r.linkedLoanId.toString() }));
  for (const [asset, cls] of [
    [r.offer.lendingAsset, r.nftClass],
    [r.offer.prepayAsset, r.prepayClass],
  ] as const) {
    if (cls === 'distrusted') out.push(copy.format('rent.blockDistrusted', { asset: meta?.[asset.toLowerCase()]?.symbol ?? shortAddress(asset) }));
  }
  const gate = gateBlock(r.gate, r.creatorGate);
  if (gate !== null) out.push(copy.text(gate.creator ? 'rentTake.blockCreatorGate' : (GATE_KEYS[gate.code] ?? 'accept.blockGateOther')));
  const lack = takeLack(r);
  const id = r.offer.tokenId.toString();
  if (lack.kind === 'no-token') out.push(copy.format('rentList.blockNoToken', { id }));
  else if (lack.kind === 'not-held') out.push(copy.format('rentTake.blockNotHeld', { id }));
  else if (lack.kind === 'units' && r.holding.kind === 'erc1155')
    out.push(copy.format('rentTake.blockUnits', { have: String(r.holding.state.balance), need: String(r.offer.quantity), id }));
  return out;
}

function offerKey(o: StoredOffer): string {
  return JSON.stringify(o, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
}

function lackKey(l: TakeLack): string {
  return l.kind === 'units' ? `units:${l.missing}` : l.kind;
}

/** What moved between the review and a re-read of it, as the page names it,
 *  or null when nothing the receipt or the signature stands on moved. */
export function takeChangedBetween(a: TakeReview, b: TakeReview, copy: Pick<CopyAccess, 'text'>): string | null {
  if (offerKey(a.offer) !== offerKey(b.offer) || a.state !== b.state || a.linkedLoanId !== b.linkedLoanId || a.riskTermsHash !== b.riskTermsHash)
    return copy.text('rentTake.changedRequest');
  if (a.preview.effectivePrincipal !== b.preview.effectivePrincipal || a.preview.error !== b.preview.error) return copy.text('rentTake.changedPreview');
  if (takeCost(a).total !== takeCost(b).total || a.requestBufferBps !== b.requestBufferBps || a.todayBufferBps !== b.todayBufferBps) return copy.text('rent.changedBuffer');
  if (
    a.nftClass !== b.nftClass ||
    a.prepayClass !== b.prepayClass ||
    a.gate !== b.gate ||
    a.creatorGate !== b.creatorGate ||
    a.graceSeconds !== b.graceSeconds ||
    a.protocolShareBps !== b.protocolShareBps
  )
    return copy.text('accept.changedClass');
  if (lackKey(takeLack(a)) !== lackKey(takeLack(b)) || takeApprovalPrompts(a) !== takeApprovalPrompts(b)) return copy.text('request.changedToken');
  if (a.vault.toLowerCase() !== b.vault.toLowerCase()) return copy.text('accept.changedVault');
  return null;
}
