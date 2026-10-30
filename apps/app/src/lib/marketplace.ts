import type { IndexedOffer, RecentLoansPage } from '../data/indexer';

export type MarketplaceSide = 'lender' | 'borrower';

export interface MarketplaceSelection {
  chainId: number;
  side: MarketplaceSide;
  lendingAsset: string;
  collateralAsset: string;
  durationDays: number | null;
  /** Exact base units; null means no size filter. */
  minimumAmount?: bigint | null;
}

export function marketplaceRate(offer: IndexedOffer): number {
  return offer.offerType === 0 ? offer.interestRateBps : offer.interestRateBpsMax;
}

export function marketplaceRemaining(offer: IndexedOffer): bigint {
  try {
    return BigInt(offer.offerType === 0 ? offer.amountMax : offer.amount) - BigInt(offer.amountFilled || '0');
  } catch {
    return 0n;
  }
}

/** ERC-20 is wire code 0. This browse filter never authorises a write;
 * the existing accept review reads and validates canonical terms again. */
export function marketplaceOffers(
  offers: readonly IndexedOffer[], selection: MarketplaceSelection, now: number,
): IndexedOffer[] {
  return offers.filter((offer) =>
    offer.chainId === selection.chainId && offer.status === 'active' &&
    offer.assetType === 0 && offer.collateralAssetType === 0 &&
    offer.offerType === (selection.side === 'lender' ? 1 : 0) &&
    offer.isSaleVehicle !== true && offer.isOffsetVehicle !== true &&
    marketplaceRemaining(offer) > 0n &&
    offer.lendingAsset.toLowerCase() === selection.lendingAsset.toLowerCase() &&
    offer.collateralAsset.toLowerCase() === selection.collateralAsset.toLowerCase() &&
    (selection.durationDays === null || offer.durationDays === selection.durationDays) &&
    (selection.minimumAmount == null ||
      marketplaceRemaining(offer) >= selection.minimumAmount) &&
    (!offer.expiresAt || offer.expiresAt > now)
  ).sort((a, b) =>
    (selection.side === 'lender' ? -1 : 1) * (marketplaceRate(a) - marketplaceRate(b)) ||
    b.offerId - a.offerId,
  );
}

/** Require the server to acknowledge the pair filter, including empty
 * responses. An older unscoped worker must not imply an empty pair. */
export function verifiedMarketplaceHistory(
  page: RecentLoansPage | null, selection: Pick<MarketplaceSelection, 'chainId' | 'lendingAsset' | 'collateralAsset'>,
): RecentLoansPage | null {
  if (!page || page.chainId !== selection.chainId ||
      page.scope?.lendingAsset?.toLowerCase() !== selection.lendingAsset.toLowerCase() ||
      page.scope?.collateralAsset?.toLowerCase() !== selection.collateralAsset.toLowerCase() ||
      page.scope?.durationDays !== null || page.scope?.excludeSaleVehicles !== true) return null;
  if (!Array.isArray(page.loans) || page.loans.some((loan) => loan.chainId !== selection.chainId ||
      loan.lendingAsset.toLowerCase() !== selection.lendingAsset.toLowerCase() ||
      loan.collateralAsset.toLowerCase() !== selection.collateralAsset.toLowerCase() ||
      loan.assetType !== 0 || loan.collateralAssetType !== 0 || loan.isSaleVehicle === true)) return null;
  return { ...page, loans: [...page.loans].sort((a, b) => b.loanId - a.loanId) };
}
