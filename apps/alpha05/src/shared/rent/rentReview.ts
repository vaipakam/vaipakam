/**
 * NFT-02 — what a renter's review of an owner's listing stands on, read in
 * one go through the wallet's connection, and the rules that turn it into
 * the blockers stated in place and the "what changed" of a re-check. The
 * protocol's preview gives the verdict and the daily fee; the up-front total
 * is the protocol's published rule (rental.ts) on the listing's own figures,
 * and the acceptance's dry run is what proves the two agree before the
 * wallet sends anything.
 *
 * A rental carries no collateral and no health factor, so none is read; the
 * risk-access check is the protocol's own for this offer, which judges a
 * rental on its prepayment token alone.
 */
import type { OwnStateClient } from '../../chain/ownRail';
import type { CopyAccess, CopyKey } from '../copy/useCopy';
import { readAssetClass, type AssetClass } from '../offers/assets';
import type { StoredOffer } from '../offers/acceptTerms';
import { gateBlock, shortfall } from '../offers/model';
import {
  readAcceptGate,
  readCreatorGate,
  readGraceSeconds,
  readLinkedLoanId,
  readOffer,
  readOfferState,
  readPreview,
  readRiskTermsHash,
  readVault,
  readWalletFunds,
  tokenAcceptsApproval,
  type AcceptPreview,
  type OfferState,
  type WalletFunds,
  statedAcceptError,
} from '../offers/reads';
import { SWITCH_EFFECTS } from '../eligibility/switchClasses';
import { tokenAmount, type TokenMetaMap } from '../reads/tokens';
import { allowanceSteps } from '../tx/approval';
import { shortAddress } from '../ui/format';
import { isListing, rentalCost, type RentalCost } from './rental';
import { readListingBufferBps, readTodayBufferBps } from './rentReads';

type Hex = `0x${string}`;

export interface RentReview {
  /** The wallet and network the review was read under (RB-REVIEW). */
  identity: string;
  offerId: bigint;
  offer: StoredOffer;
  state: OfferState;
  preview: AcceptPreview;
  linkedLoanId: bigint;
  riskTermsHash: Hex;
  /** The rented NFT's class (an NFT is unpriced: illiquid). */
  nftClass: AssetClass;
  /** The prepayment token's class. */
  prepayClass: AssetClass;
  graceSeconds: bigint;
  /** The buffer share the listing recorded (0: none recorded). */
  listingBufferBps: bigint;
  /** The protocol's buffer setting now. */
  todayBufferBps: bigint;
  /** This wallet's vault; the zero address when this rental opens it. */
  vault: Hex;
  /** The wallet's balance and allowance of the prepayment token. */
  funds: WalletFunds;
  /** Wallet prompts the approval takes (0, 1, or 2 when set to zero first). */
  approvalSteps: number;
  gate: number;
  creatorGate: number;
  readAt: number;
}

/** What the rental takes up front, from the review's figures. The protocol
 *  rents at the listing's own daily fee (the preview reports it as the
 *  amount), for the listing's term. */
export function reviewCost(r: Pick<RentReview, 'preview' | 'offer' | 'listingBufferBps' | 'todayBufferBps'>): RentalCost {
  return rentalCost(r.preview.effectivePrincipal, r.offer.durationDays, r.listingBufferBps, r.todayBufferBps);
}

export class NotAListing extends Error {
  readonly offerId: bigint;
  constructor(offerId: bigint) {
    super(`offer #${offerId.toString()} is not an NFT listed for rent`);
    this.offerId = offerId;
  }
}

export async function readRentReview(own: OwnStateClient, diamond: Hex, offerId: bigint, identity: string): Promise<RentReview> {
  const account = own.account;
  const r = <T>(fn: Parameters<OwnStateClient['read']>[0]) => own.read(fn).then((x) => x.value as T);
  const offer = await r<StoredOffer>((c) => readOffer(c, diamond, offerId));
  if (!isListing(offer)) throw new NotAListing(offerId);
  const [state, preview, linkedLoanId, riskTermsHash, nftClass, prepayClass, graceSeconds, listingBufferBps, todayBufferBps, vault, funds, gate, creatorGate] = await Promise.all([
    r<OfferState>((c) => readOfferState(c, diamond, offerId)),
    r<AcceptPreview>((c) => readPreview(c, diamond, offerId, account)),
    r<bigint>((c) => readLinkedLoanId(c, diamond, offerId)),
    r<Hex>((c) => readRiskTermsHash(c, diamond)),
    r<AssetClass>((c) => readAssetClass(c, diamond, offer.lendingAsset)),
    r<AssetClass>((c) => readAssetClass(c, diamond, offer.prepayAsset)),
    r<bigint>((c) => readGraceSeconds(c, diamond, offer.durationDays)),
    r<bigint>((c) => readListingBufferBps(c, diamond, offerId)),
    r<bigint>((c) => readTodayBufferBps(c, diamond)),
    r<Hex>((c) => readVault(c, diamond, account)),
    r<WalletFunds>((c) => readWalletFunds(c, offer.prepayAsset, account, diamond)),
    r<number>((c) => readAcceptGate(c, diamond, offerId, account)),
    r<number>((c) => readCreatorGate(c, diamond, offerId)),
  ]);
  const total = rentalCost(preview.effectivePrincipal, offer.durationDays, listingBufferBps, todayBufferBps).total;
  const approvalSteps =
    funds.allowance >= total
      ? 0
      : (await allowanceSteps({ accepts: (amount) => r<boolean>((c) => tokenAcceptsApproval(c, offer.prepayAsset, account, diamond, amount)) }, funds.allowance, total)).length;
  return {
    identity,
    offerId,
    offer,
    state,
    preview,
    linkedLoanId,
    riskTermsHash,
    nftClass,
    prepayClass,
    graceSeconds,
    listingBufferBps,
    todayBufferBps,
    vault,
    funds,
    approvalSteps,
    gate,
    creatorGate,
    readAt: Date.now(),
  };
}

export function needsApproval(r: Pick<RentReview, 'funds' | 'preview' | 'offer' | 'listingBufferBps' | 'todayBufferBps'>): boolean {
  return r.funds.allowance < reviewCost(r).total;
}

/** The signed terms, the approval when one is needed, and the acceptance. */
export function promptCount(r: Pick<RentReview, 'approvalSteps'>): number {
  return 2 + r.approvalSteps;
}

const STATE_KEYS: Readonly<Record<Exclude<OfferState, 'open'>, CopyKey>> = {
  accepted: 'rent.stateAccepted',
  cancelled: 'rent.stateCancelled',
  expired: 'rent.stateExpired',
  'sale-consumed': 'borrow.stateSaleConsumed',
};

/** The refusals whose wording names the other side or a loan, as a renter
 *  reads them; every other refusal reads the same as a loan's. */
const RENT_ERRORS: Partial<Record<AcceptPreview['error'], CopyKey>> = {
  OfferAlreadyAccepted: 'rent.err.OfferAlreadyAccepted',
  SanctionedAcceptor: 'rent.err.SanctionedAcceptor',
  SanctionedCreator: 'rent.err.SanctionedCreator',
  AssetPaused: 'rent.err.AssetPaused',
  RiskAndTermsConsentRequired: 'rent.err.RiskAndTermsConsentRequired',
  OfferExpired: 'rent.err.OfferExpired',
  OfferIsCancelled: 'rent.err.OfferIsCancelled',
  SelfTrade: 'rent.err.SelfTrade',
  Unrecognised: 'rent.err.Unrecognised',
};

const GATE_KEYS: Readonly<Record<number, CopyKey>> = { 1: 'risk.blockTier', 2: 'risk.blockConsent', 3: 'risk.blockAck', 4: 'risk.blockConsent' };

/** The protocol's first refusal of this rental, as a renter reads it. */
export function rentErrorText(code: AcceptPreview['error'], copy: Pick<CopyAccess, 'text' | 'format'>): string {
  const error = statedAcceptError(code);
  if (error === 'None') return '';
  if (error === 'ProtocolPaused') return copy.format('rent.err.ProtocolPaused', { staysOpen: SWITCH_EFFECTS['2'].staysOpen });
  return copy.text(RENT_ERRORS[error] ?? (`accept.err.${error}` as CopyKey));
}

/**
 * Every reason the wallet must not open for this rental, in the order the
 * reader should meet them; empty when the protocol reports nothing and the
 * wallet holds the rent and buffer.
 */
export function rentBlockers(r: RentReview, meta: TokenMetaMap | null, copy: Pick<CopyAccess, 'text' | 'format'>): string[] {
  const out: string[] = [];
  if (r.state !== 'open') out.push(copy.format('rent.blockState', { state: copy.text(STATE_KEYS[r.state]) }));
  else if (r.preview.error !== 'None') out.push(rentErrorText(r.preview.error, copy));
  // A rental is never tied to a running loan; one that says it is is not a
  // listing this review describes.
  if (r.linkedLoanId !== 0n) out.push(copy.format('rent.blockLinked', { id: r.linkedLoanId.toString() }));
  for (const [asset, cls] of [
    [r.offer.lendingAsset, r.nftClass],
    [r.offer.prepayAsset, r.prepayClass],
  ] as const) {
    if (cls === 'distrusted') out.push(copy.format('rent.blockDistrusted', { asset: meta?.[asset.toLowerCase()]?.symbol ?? shortAddress(asset) }));
  }
  const gate = gateBlock(r.gate, r.creatorGate);
  if (gate !== null) out.push(copy.text(gate.creator ? 'rent.blockCreatorGate' : (GATE_KEYS[gate.code] ?? 'accept.blockGateOther')));
  const total = reviewCost(r).total;
  const missing = shortfall(r.funds.balance, total);
  if (missing > 0n) {
    const amt = (v: bigint) => tokenAmount(v, r.offer.prepayAsset, meta, copy.format);
    out.push(copy.format('rent.blockShortfall', { have: amt(r.funds.balance), missing: amt(missing), need: amt(total) }));
  }
  return out;
}

function offerKey(o: StoredOffer): string {
  return JSON.stringify(o, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
}

/** What moved between the review and a re-read of it, as the page names it,
 *  or null when nothing the receipt or the signature stands on moved. */
export function rentChangedBetween(a: RentReview, b: RentReview, copy: Pick<CopyAccess, 'text'>): string | null {
  if (offerKey(a.offer) !== offerKey(b.offer) || a.state !== b.state || a.linkedLoanId !== b.linkedLoanId || a.riskTermsHash !== b.riskTermsHash)
    return copy.text('rent.changedListing');
  if (a.preview.effectivePrincipal !== b.preview.effectivePrincipal || a.preview.error !== b.preview.error) return copy.text('rent.changedPreview');
  if (reviewCost(a).total !== reviewCost(b).total || a.listingBufferBps !== b.listingBufferBps || a.todayBufferBps !== b.todayBufferBps)
    return copy.text('rent.changedBuffer');
  if (a.nftClass !== b.nftClass || a.prepayClass !== b.prepayClass || a.gate !== b.gate || a.creatorGate !== b.creatorGate || a.graceSeconds !== b.graceSeconds)
    return copy.text('accept.changedClass');
  const total = reviewCost(a).total;
  if (shortfall(a.funds.balance, total) !== shortfall(b.funds.balance, total) || needsApproval(a) !== needsApproval(b) || a.approvalSteps !== b.approvalSteps)
    return copy.text('accept.changedFunds');
  if (a.vault.toLowerCase() !== b.vault.toLowerCase()) return copy.text('accept.changedVault');
  return null;
}
