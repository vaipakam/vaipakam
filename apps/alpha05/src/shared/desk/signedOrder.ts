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

/** The domain `LibSignedOffer.domainSeparator()` computes: bound to one
 *  network and one deployment, so a signature never fills elsewhere. */
export function signedOfferDomain(chainId: number, diamond: Hex) {
  return { name: 'Vaipakam SignedOffer', version: '1', chainId, verifyingContract: diamond } as const;
}

/** A random batch-cancel nonce (128 bits), so cancelling a new order by its
 *  nonce stops that order alone. */
export function randomNonce(random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array = (b) => crypto.getRandomValues(b)): bigint {
  const bytes = random(new Uint8Array(16));
  return bytes.reduce((n, b) => (n << 8n) | BigInt(b), 0n);
}

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

/** The order's principal ceiling: `amountMax`, or `amount` when that is
 *  zero. A cancel marks this figure as filled; a match fills slices up to
 *  it (`SignedOfferMatchFacet`), so a cumulative fill below it leaves the
 *  rest fillable. */
export function signedCeiling(o: SignedOrderWire): bigint {
  const max = BigInt(o.amountMax);
  return max === 0n ? BigInt(o.amount) : max;
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

/** What the rest of a partly filled order could still draw from the
 *  signer's vault. A lender's is the principal left under the ceiling; a
 *  borrower's is the collateral for that principal at the order's own
 *  collateral-to-principal ratio (a matched signed order must keep that
 *  ratio constant), rounded up so the figure is never an understatement. */
export function signedStakeLeft(o: SignedOrderWire, filled: bigint): { asset: Hex; amount: bigint } {
  const stake = signedStake(o);
  const ceiling = signedCeiling(o);
  const left = filled >= ceiling ? 0n : ceiling - filled;
  if (o.offerType === SIGNED_LENDER) return { asset: stake.asset, amount: left };
  if (ceiling === 0n) return { asset: stake.asset, amount: 0n };
  return { asset: stake.asset, amount: (stake.amount * left + ceiling - 1n) / ceiling };
}

/** What the offer book answered to a listing. */
export type BookAnswer =
  /** Listed now (`fresh`), or already listed and still open. */
  | { kind: 'listed'; orderHash: Hex; fresh: boolean }
  /** The book refused it and listed nothing; `code` is the book's own. */
  | { kind: 'refused'; code: string }
  /** No answer the app can read: whether it was listed is not known. */
  | { kind: 'unknown'; reason: string };

/** The book's answer to `POST /signed-offers`: 201 lists it, 200 says it
 *  was already listed, a 4xx with the book's error code refused it; any
 *  other answer (a 5xx, a body this app cannot read) leaves it unknown. A
 *  listing must name the order this app signed.
 *
 *  A refusal is final only when it is about the order. A 408 or 429 is about
 *  the request (the book refuses a rate-limited caller before it looks for
 *  the order), so it proves nothing about an earlier send whose answer was
 *  lost, and leaves the order unknown with its resend. Every other refusal
 *  either comes from checks an earlier send would have failed too (shape,
 *  signature, chain) or says the order can no longer be filled (lapsed,
 *  used, its nonce cancelled), so dropping the signature then can never
 *  leave a fillable order behind unseen. */
export function bookAnswer(status: number, body: unknown, expected: Hex): BookAnswer {
  const b = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  if (status === 201 || status === 200) {
    if (typeof b.orderHash === 'string' && b.orderHash.toLowerCase() === expected.toLowerCase()) {
      return { kind: 'listed', orderHash: expected, fresh: status === 201 };
    }
    return { kind: 'unknown', reason: `the offer book answered ${status} without naming this order` };
  }
  if (status === 408 || status === 429) return { kind: 'unknown', reason: `the offer book did not take the request now (${status})` };
  if (status >= 400 && status < 500 && typeof b.error === 'string' && b.error !== '') return { kind: 'refused', code: b.error };
  return { kind: 'unknown', reason: `the offer book answered ${status}` };
}
