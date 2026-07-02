import type { ActiveOffersPage, IndexedOffer } from '../types/offers.js';
import { fetchIndexerJson } from './client.js';
import { OFFER_TYPE_BORROWER, OFFER_TYPE_LENDER } from '../types/offers.js';

export async function fetchActiveOffers(
  indexerOrigin: string | undefined,
  chainId: number,
  opts: { limit?: number; before?: number } = {},
): Promise<ActiveOffersPage | null> {
  const params = new URLSearchParams({ chainId: String(chainId) });
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.before) params.set('before', String(opts.before));
  return fetchIndexerJson<ActiveOffersPage>(indexerOrigin, `/offers/active?${params}`);
}

export async function fetchAllActiveOffers(
  indexerOrigin: string | undefined,
  chainId: number,
  limit = 200,
): Promise<IndexedOffer[]> {
  const all: IndexedOffer[] = [];
  let before: number | undefined;
  for (let page = 0; page < 25; page++) {
    const res = await fetchActiveOffers(indexerOrigin, chainId, { limit, before });
    if (!res) break;
    all.push(...res.offers);
    if (res.nextBefore == null) break;
    before = res.nextBefore;
  }
  return all;
}

/** Lender offers a borrower can accept (B1 journey). */
export function filterLenderOffersForBorrow(offers: IndexedOffer[]): IndexedOffer[] {
  return offers.filter(
    (o) => o.status === 'active' && o.offerType === OFFER_TYPE_LENDER,
  );
}

/** Borrower requests a lender can fund (L1 journey). */
export function filterBorrowerOffersForLend(offers: IndexedOffer[]): IndexedOffer[] {
  return offers.filter(
    (o) => o.status === 'active' && o.offerType === OFFER_TYPE_BORROWER,
  );
}

export interface BorrowIntent {
  lendingAsset?: string;
  collateralAsset?: string;
  durationDays?: number;
  maxRateBps?: number;
}

/** Narrow offers to the user's stated borrow intent (Basic mode defaults). */
export function matchOffersToBorrowIntent(
  offers: IndexedOffer[],
  intent: BorrowIntent,
): IndexedOffer[] {
  return offers.filter((o) => {
    if (intent.lendingAsset && o.lendingAsset.toLowerCase() !== intent.lendingAsset.toLowerCase()) {
      return false;
    }
    if (intent.collateralAsset && o.collateralAsset.toLowerCase() !== intent.collateralAsset.toLowerCase()) {
      return false;
    }
    if (intent.durationDays && o.durationDays !== intent.durationDays) {
      return false;
    }
    if (intent.maxRateBps != null && o.interestRateBps > intent.maxRateBps) {
      return false;
    }
    return true;
  });
}