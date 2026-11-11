/**
 * OFF-59 / OFF-61 — a gasless signed order: the maker signs an offer's terms
 * off the chain (EIP-712) and the offer book lists the signature; nothing
 * reaches the chain until a taker fills it, and nothing is set aside before
 * then. The only way to stop one is on the chain: `cancelSignedOffer` marks
 * its order hash used, `invalidateSignedOfferNonce` stops every order the
 * signer signed with one nonce. Taking it off the book alone stops nothing,
 * because anyone holding the signature can still fill it.
 *
 * This module is the order itself: its wire form (`@vaipakam/lib/
 * signedOfferWire`, the one the book stores and a taker replays), the
 * message viem's typed-data encoder takes, its hash (the key the chain and
 * the book share), and the stake a fill would draw from the signer's own
 * vault (`OfferCreateFacet._creatorPullAmount`).
 */
import { hashStruct, type Address } from 'viem';
import { SIGNED_OFFER_FIELDS, type SignedOrderWire } from '@vaipakam/lib/signedOfferWire';

type Hex = `0x${string}`;

export type { SignedOrderWire };

/** The typed-data description the signer signs, in the contract's field order. */
export const SIGNED_OFFER_TYPES = { SignedOffer: SIGNED_OFFER_FIELDS } as const;

/** `LibVaipakam.OfferType.Lender`. */
export const SIGNED_LENDER = '0';

/** The message viem's typed-data encoder takes for a wire order; the same
 *  struct `cancelSignedOffer` takes. */
export function typedMessage(o: SignedOrderWire) {
  return {
    offerType: Number(o.offerType),
    lendingAsset: o.lendingAsset as Address,
    amount: BigInt(o.amount),
    amountMax: BigInt(o.amountMax),
    interestRateBps: BigInt(o.interestRateBps),
    interestRateBpsMax: BigInt(o.interestRateBpsMax),
    collateralAsset: o.collateralAsset as Address,
    collateralAmount: BigInt(o.collateralAmount),
    collateralAmountMax: BigInt(o.collateralAmountMax),
    durationDays: BigInt(o.durationDays),
    assetType: Number(o.assetType),
    collateralAssetType: Number(o.collateralAssetType),
    tokenId: BigInt(o.tokenId),
    quantity: BigInt(o.quantity),
    collateralTokenId: BigInt(o.collateralTokenId),
    collateralQuantity: BigInt(o.collateralQuantity),
    prepayAsset: o.prepayAsset as Address,
    allowsPartialRepay: o.allowsPartialRepay,
    allowsPrepayListing: o.allowsPrepayListing,
    allowsParallelSale: o.allowsParallelSale,
    expiresAt: BigInt(o.expiresAt),
    fillMode: Number(o.fillMode),
    periodicInterestCadence: Number(o.periodicInterestCadence),
    refinanceTargetLoanId: BigInt(o.refinanceTargetLoanId),
    useFullTermInterest: o.useFullTermInterest,
    creatorFull: o.creatorFull,
    creatorMaxCStar: BigInt(o.creatorMaxCStar),
    creatorAllowFullDowngrade: o.creatorAllowFullDowngrade,
    signer: o.signer as Address,
    nonce: BigInt(o.nonce),
    deadline: BigInt(o.deadline),
  };
}

/** The order's key on the chain and in the book: the EIP-712 struct hash,
 *  the figure `signedOfferOrderHash` returns. */
export function orderHashOf(o: SignedOrderWire): Hex {
  return hashStruct({ data: typedMessage(o), primaryType: 'SignedOffer', types: SIGNED_OFFER_TYPES });
}

/** The stake a fill draws from the signer's vault, by the protocol's rule:
 *  a lender's whole amount (`amountMax`, or `amount` when that is zero); a
 *  borrower's whole collateral (`collateralAmountMax`, or `collateralAmount`
 *  when that is zero). */
export function signedStake(o: SignedOrderWire): { asset: Hex; amount: bigint } {
  if (o.offerType === SIGNED_LENDER) {
    const max = BigInt(o.amountMax);
    return { asset: o.lendingAsset as Hex, amount: max === 0n ? BigInt(o.amount) : max };
  }
  const max = BigInt(o.collateralAmountMax);
  return { asset: o.collateralAsset as Hex, amount: max === 0n ? BigInt(o.collateralAmount) : max };
}

/** When the order stops being fillable, in chain seconds: the earlier of its
 *  expiry and its signature's deadline; null when neither is set (it stays
 *  fillable until cancelled on the chain). */
export function lapsesAt(o: SignedOrderWire): number | null {
  const times = [BigInt(o.expiresAt), BigInt(o.deadline)].filter((t) => t !== 0n);
  if (times.length === 0) return null;
  return Number(times.reduce((a, b) => (a < b ? a : b)));
}
