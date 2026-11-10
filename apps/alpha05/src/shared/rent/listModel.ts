/**
 * NFT-01 — an owner's listing of an NFT for rent, as the form produces it and
 * as the protocol stores it. A listing names one NFT (an ERC-721 token, or a
 * quantity of one ERC-1155 token), the token the renter pays in, a DAILY fee
 * in that token's units (one figure: a rental's fee is never a range), the
 * term in days and the rent rule. It carries no collateral and no interest
 * rate. Posting moves the NFT from the owner's wallet into the owner's own
 * vault, where it stays while the listing is open and while it is rented.
 */
import { ASSET_ERC721, ASSET_ERC1155, OFFER_TYPE_BORROWER, OFFER_TYPE_LENDER, ZERO } from '../post/postModel';

type Hex = `0x${string}`;

export type ListStandard = 'erc721' | 'erc1155';

export interface ListDraft {
  nft: Hex;
  standard: ListStandard;
  tokenId: bigint;
  /** 1 for an ERC-721 token; the units rented for an ERC-1155 token. */
  quantity: bigint;
  /** The token the renter pays the rent and buffer in. */
  payment: Hex;
  /** The daily fee, in the payment token's base units. */
  dailyFee: bigint;
  days: bigint;
  /** Full term: the whole term is owed even if the renter closes early.
   *  Otherwise pro-rata: the days used, a part day counted whole. */
  fullTerm: boolean;
  /** 0: open until taken or cancelled. */
  expiresAt: bigint;
}

/** The protocol's `CreateOfferParams` for a listing: an owner-side offer
 *  whose lent asset is the NFT, with every collateral and rate field zero. */
export function listParams(d: ListDraft) {
  return {
    offerType: OFFER_TYPE_LENDER,
    lendingAsset: d.nft,
    amount: d.dailyFee,
    interestRateBps: 0n,
    collateralAsset: ZERO,
    collateralAmount: 0n,
    durationDays: d.days,
    assetType: d.standard === 'erc721' ? ASSET_ERC721 : ASSET_ERC1155,
    tokenId: d.tokenId,
    quantity: d.standard === 'erc721' ? 1n : d.quantity,
    creatorRiskAndTermsConsent: true,
    prepayAsset: d.payment,
    collateralAssetType: 0,
    collateralTokenId: 0n,
    collateralQuantity: 0n,
    allowsPartialRepay: false,
    amountMax: d.dailyFee,
    interestRateBpsMax: 0n,
    collateralAmountMax: 0n,
    periodicInterestCadence: 0,
    expiresAt: d.expiresAt,
    fillMode: 0,
    allowsPrepayListing: false,
    allowsParallelSale: false,
    refinanceTargetLoanId: 0n,
    useFullTermInterest: d.fullTerm,
  } as const;
}

export type ListParams = ReturnType<typeof listParams>;

/** The protocol's `CreateOfferParams` for a renter's request (NFT-02): the
 *  same rental terms on a renter-side offer. The NFT stays with its owner
 *  until one takes the request; posting moves the rent for the whole term
 *  and the buffer from the renter's wallet into the renter's own vault. */
export function requestParams(d: ListDraft) {
  return { ...listParams(d), offerType: OFFER_TYPE_BORROWER } as const;
}

export type RequestParams = ReturnType<typeof requestParams>;

/** A whole number of units, at least one, as typed. */
export function parseUnits(text: string): bigint | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const v = BigInt(t);
  return v >= 1n ? v : null;
}
