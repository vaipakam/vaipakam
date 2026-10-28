/**
 * Where an offer is taken — the one mapping from an offer to the guided
 * flow that accepts it.
 *
 * The Offer Book's "Use this offer" button and the retired app's
 * `/offers/:offerId` bookmarks (#2076) both need it, and a second copy would
 * give the two somewhere to disagree: a bookmark landing in the wrong flow
 * is refused there as the wrong side, which reads as a dead link.
 *
 * Offer ids are PER-CHAIN, so the path always carries the chain the offer
 * was read on; the flows refuse to select an offer whose chain is not the
 * active read chain.
 */
import { AssetType } from '../lib/types';
import type { IndexedOffer } from './indexer';

type OfferRouting = Pick<IndexedOffer, 'offerId' | 'chainId' | 'offerType' | 'assetType'>;

/** An NFT rental listing: an owner's lending offer whose asset is not an
 *  ERC-20. Its price lives in the prepay asset, not in a loan rate. */
export function isRentalListing(offer: Pick<IndexedOffer, 'offerType' | 'assetType'>): boolean {
  return offer.assetType !== AssetType.ERC20 && offer.offerType === 0;
}

/** The flow that takes `offer`: a rental listing is rented, a lending offer
 *  is borrowed against, a borrow request is lent into. */
export function offerAcceptPath(offer: OfferRouting): string {
  const query = `?offer=${offer.offerId}&chain=${offer.chainId}`;
  if (isRentalListing(offer)) return `/rent${query}`;
  return offer.offerType === 0 ? `/borrow${query}` : `/lend${query}`;
}
