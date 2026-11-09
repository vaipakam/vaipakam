/**
 * OFF-41, OFF-45 — one offer as the chain holds it, read at one block: its
 * stored terms, the state the protocol reports, and the loan it is tied to
 * when it is a loan-sale or offset offer. The detail page acts on this read,
 * never on the index's row, so a stale book can never offer an action the
 * protocol would refuse.
 *
 * The protocol keeps no count of offers, and an offer cancelled before
 * anything filled it has its terms cleared, so an id with no stored terms
 * is reported as exactly that: cancelled, or never posted. Which one is not
 * known, and the page says so.
 */
import type { PublicClient } from 'viem';
import { ASSET_ERC20, OFFER_TYPE_LENDER } from '../positions/model';
import { ZERO_ADDRESS, type StoredOffer } from './acceptTerms';
import type { BookKind } from './book';
import { readLinkedLoanId, readOffer, readOfferState, type OfferState } from './reads';

type Hex = `0x${string}`;

export type OfferDetail =
  | { kind: 'no-terms'; id: bigint; block: bigint }
  | {
      kind: 'offer';
      id: bigint;
      offer: StoredOffer;
      state: OfferState;
      /** What the offer is for, from the chain (never `refinance-unknown`). */
      purpose: Exclude<BookKind, 'refinance-unknown'>;
      /** The running loan a loan-sale or offset offer is tied to; 0 otherwise. */
      linkedLoanId: bigint;
      block: bigint;
    };

export function purposeOf(o: Pick<StoredOffer, 'offerType' | 'refinanceTargetLoanId'>, linkedLoanId: bigint): Exclude<BookKind, 'refinance-unknown'> {
  if (linkedLoanId !== 0n) return o.offerType === OFFER_TYPE_LENDER ? 'offset' : 'loan-sale';
  return o.offerType !== OFFER_TYPE_LENDER && o.refinanceTargetLoanId > 0n ? 'refinance' : 'plain';
}

export async function readOfferDetail(client: PublicClient, diamond: Hex, id: bigint): Promise<OfferDetail> {
  const block = await client.getBlockNumber({ cacheTime: 0 });
  const at = { blockNumber: block };
  const offer = await readOffer(client, diamond, id, at);
  if (offer.creator.toLowerCase() === ZERO_ADDRESS) return { kind: 'no-terms', id, block };
  const [state, linkedLoanId] = await Promise.all([readOfferState(client, diamond, id, at), readLinkedLoanId(client, diamond, id, at)]);
  return { kind: 'offer', id, offer, state, purpose: purposeOf(offer, linkedLoanId), linkedLoanId, block };
}

/** What the reader may do with an offer from its detail page. Taking it is
 *  offered here for a loan of an ERC-20 against ERC-20 collateral that is a
 *  plain offer or a refinance request (the shared acceptance flow), and for
 *  an owner's NFT listed for rent (the rental flow); every other kind says
 *  where it is taken instead. */
export type DetailAction =
  | { kind: 'accept' }
  /** An owner's NFT listed for rent: rented here (NFT-02). */
  | { kind: 'rent' }
  | { kind: 'cancel' }
  | { kind: 'clean-up' }
  | { kind: 'connect' }
  /** A renter's request, an NFT loan, a loan sale or an offset: not taken in this app yet. */
  | { kind: 'elsewhere'; why: 'rental' | 'nft' | 'loan-sale' | 'offset' }
  /** Nothing to do: the offer ended. */
  | { kind: 'none' };

export function detailAction(d: Extract<OfferDetail, { kind: 'offer' }>, viewer: Hex | null): DetailAction {
  const o = d.offer;
  const mine = viewer !== null && o.creator.toLowerCase() === viewer.toLowerCase();
  if (d.state === 'expired') return viewer === null ? { kind: 'connect' } : { kind: 'clean-up' };
  if (d.state !== 'open') return { kind: 'none' };
  if (mine) return { kind: 'cancel' };
  if (d.purpose === 'loan-sale' || d.purpose === 'offset') return { kind: 'elsewhere', why: d.purpose };
  if (o.assetType !== ASSET_ERC20) {
    if (o.offerType !== OFFER_TYPE_LENDER) return { kind: 'elsewhere', why: 'rental' };
    return viewer === null ? { kind: 'connect' } : { kind: 'rent' };
  }
  if (o.collateralAssetType !== ASSET_ERC20) return { kind: 'elsewhere', why: 'nft' };
  return viewer === null ? { kind: 'connect' } : { kind: 'accept' };
}
