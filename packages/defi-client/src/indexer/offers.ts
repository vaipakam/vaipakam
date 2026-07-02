import type { ActiveOffersPage, CreatorOffersPage, IndexedOffer } from '../types/offers.js';
import { ASSET_TYPE_ERC20, OFFER_TYPE_BORROWER, OFFER_TYPE_LENDER } from '../types/offers.js';
import { fetchIndexerJson } from './client.js';

export interface HolderOffersPage {
  chainId: number;
  address: string;
  offers: IndexedOffer[];
  nextBefore: number | null;
}

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

export async function fetchOffersByCreator(
  indexerOrigin: string | undefined,
  chainId: number,
  creator: string,
  opts: { limit?: number; before?: number } = {},
): Promise<CreatorOffersPage | null> {
  const params = new URLSearchParams({ chainId: String(chainId) });
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.before) params.set('before', String(opts.before));
  return fetchIndexerJson<CreatorOffersPage>(
    indexerOrigin,
    `/offers/by-creator/${creator.toLowerCase()}?${params}`,
  );
}

export async function fetchOffersByCurrentHolder(
  indexerOrigin: string | undefined,
  chainId: number,
  holder: string,
  opts: { limit?: number; before?: number } = {},
): Promise<HolderOffersPage | null> {
  const params = new URLSearchParams({ chainId: String(chainId) });
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.before) params.set('before', String(opts.before));
  return fetchIndexerJson<HolderOffersPage>(
    indexerOrigin,
    `/offers/by-current-holder/${holder.toLowerCase()}?${params}`,
  );
}

export async function fetchAllOffersByCreator(
  indexerOrigin: string | undefined,
  chainId: number,
  creator: string,
): Promise<IndexedOffer[]> {
  const all: IndexedOffer[] = [];
  let before: number | undefined;
  for (let page = 0; page < 25; page++) {
    const res = await fetchOffersByCreator(indexerOrigin, chainId, creator, {
      limit: 100,
      before,
    });
    if (!res) break;
    all.push(...res.offers);
    if (res.nextBefore == null) break;
    before = res.nextBefore;
  }
  return all;
}

export async function fetchAllOffersByCurrentHolder(
  indexerOrigin: string | undefined,
  chainId: number,
  holder: string,
): Promise<IndexedOffer[]> {
  const all: IndexedOffer[] = [];
  let before: number | undefined;
  for (let page = 0; page < 25; page++) {
    const res = await fetchOffersByCurrentHolder(indexerOrigin, chainId, holder, {
      limit: 100,
      before,
    });
    if (!res) break;
    all.push(...res.offers);
    if (res.nextBefore == null) break;
    before = res.nextBefore;
  }
  return all;
}

/** Wallet-owned offers still open on the book. */
export function filterActiveOffersByCreator(offers: IndexedOffer[]): IndexedOffer[] {
  return offers.filter((o) => o.status === 'active');
}

/** alpha01 supports ERC-20 principal + ERC-20 collateral offers only. */
export function isAlpha01Erc20Offer(o: IndexedOffer): boolean {
  return o.assetType === ASSET_TYPE_ERC20 && o.collateralAssetType === ASSET_TYPE_ERC20;
}

/** Direct accept rejects partially-filled and expired GTT offers on-chain. */
export function isDirectAcceptableOffer(
  o: IndexedOffer,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  if (o.expiresAt != null && o.expiresAt > 0 && o.expiresAt <= nowSec) return false;
  if (o.amountFilled != null && BigInt(o.amountFilled) > 0n) return false;
  return true;
}

/** Lender offers a borrower can accept (B1 journey). */
export function filterLenderOffersForBorrow(offers: IndexedOffer[]): IndexedOffer[] {
  return offers.filter(
    (o) =>
      o.status === 'active' &&
      o.offerType === OFFER_TYPE_LENDER &&
      isAlpha01Erc20Offer(o) &&
      isDirectAcceptableOffer(o),
  );
}

/** Borrower requests a lender can fund (L1 journey). */
export function filterBorrowerOffersForLend(offers: IndexedOffer[]): IndexedOffer[] {
  return offers.filter(
    (o) =>
      o.status === 'active' &&
      o.offerType === OFFER_TYPE_BORROWER &&
      isAlpha01Erc20Offer(o) &&
      isDirectAcceptableOffer(o),
  );
}

export interface BorrowIntent {
  lendingAsset?: string;
  collateralAsset?: string;
  durationDays?: number;
  maxRateBps?: number;
  minBorrowAmountWei?: bigint;
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
    if (intent.minBorrowAmountWei != null && intent.minBorrowAmountWei > 0n) {
      const principal = BigInt(o.amountMax || o.amount || '0');
      if (principal < intent.minBorrowAmountWei) return false;
    }
    return true;
  });
}