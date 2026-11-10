/**
 * NFT-02 / NFT-03 — what a rental costs up front, by the protocol's own rule,
 * and which offers are rentals. A rental offer's amount is the DAILY fee in
 * its prepayment token; the renter moves the rent for the whole term plus a
 * buffer into their own vault when the rental starts. The buffer is a share
 * of the rent fixed on the listing when it was posted, or, for a listing
 * posted before listings recorded it, the protocol's setting at the moment
 * the rental starts. Both rounded down, as the protocol rounds them.
 */
import { ASSET_ERC20, OFFER_LENDER, type StoredOffer } from '../offers/acceptTerms';

export const BPS = 10_000n;

export interface RentalCost {
  dailyFee: bigint;
  days: bigint;
  /** Daily fee times the term. */
  rent: bigint;
  bufferBps: bigint;
  /** Where the buffer share comes from: the listing's own record, or the
   *  protocol's setting today (which governance can change before the
   *  rental starts). */
  bufferFrom: 'listing' | 'today';
  buffer: bigint;
  /** Rent plus buffer: what moves from the wallet into the renter's vault. */
  total: bigint;
}

export function rentalCost(dailyFee: bigint, days: bigint, listingBufferBps: bigint, todayBufferBps: bigint): RentalCost {
  const bufferFrom = listingBufferBps > 0n ? 'listing' : 'today';
  const bufferBps = bufferFrom === 'listing' ? listingBufferBps : todayBufferBps;
  const rent = dailyFee * days;
  const buffer = (rent * bufferBps) / BPS;
  return { dailyFee, days, rent, bufferBps, bufferFrom, buffer, total: rent + buffer };
}

/** A rental offer: the lent asset is an NFT (ERC-721 or ERC-1155). */
export function isRental(o: Pick<StoredOffer, 'assetType'>): boolean {
  return o.assetType !== ASSET_ERC20;
}

/** An owner's listing: a rental posted by the NFT's owner, which a renter
 *  takes here by paying the rent and buffer up front. */
export function isListing(o: Pick<StoredOffer, 'assetType' | 'offerType'>): boolean {
  return isRental(o) && o.offerType === OFFER_LENDER;
}
