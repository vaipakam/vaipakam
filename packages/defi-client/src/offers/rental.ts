import type { IndexedOffer } from '../types/offers.js';
import { ASSET_TYPE_ERC20, ASSET_TYPE_ERC721, ASSET_TYPE_ERC1155 } from '../types/offers.js';

export const DEFAULT_RENTAL_BUFFER_BPS = 500;
const BASIS_POINTS = 10_000n;

export function isNftAssetType(assetType: number): boolean {
  return assetType === ASSET_TYPE_ERC721 || assetType === ASSET_TYPE_ERC1155;
}

export function isNftRentalOffer(offer: Pick<IndexedOffer, 'assetType'>): boolean {
  return isNftAssetType(offer.assetType);
}

/** Daily rental fee in prepay-token wei (on-chain `amount` for NFT principal offers). */
export function rentalDailyFeeWei(offer: Pick<IndexedOffer, 'amount'>): bigint {
  return BigInt(offer.amount?.trim() || '0');
}

/** Total prepay the renter locks: daily fee × duration × (1 + rental buffer). */
export function computeRentalPrepayWei(
  dailyFeeWei: bigint,
  durationDays: number,
  rentalBufferBps = DEFAULT_RENTAL_BUFFER_BPS,
): bigint {
  if (dailyFeeWei <= 0n || durationDays <= 0) return 0n;
  const base = dailyFeeWei * BigInt(durationDays);
  return (base * (BASIS_POINTS + BigInt(rentalBufferBps))) / BASIS_POINTS;
}

export function rentalPrepayForOffer(
  offer: Pick<IndexedOffer, 'amount' | 'durationDays'>,
  rentalBufferBps = DEFAULT_RENTAL_BUFFER_BPS,
): bigint {
  return computeRentalPrepayWei(rentalDailyFeeWei(offer), offer.durationDays, rentalBufferBps);
}

export interface OfferHeadlineInput {
  assetType: number;
  offerType: number;
  amount: string;
  amountMax: string;
  interestRateBps: number;
  interestRateBpsMax: number;
}

/** Mirrors apps/defi `offerHeadline` — NFT rentals use `amount` as the daily fee. */
export function offerHeadline(offer: OfferHeadlineInput): { principalWei: bigint; rateBps: number } {
  const amount = BigInt(offer.amount?.trim() || '0');
  const amountMax = BigInt(offer.amountMax?.trim() || '0');
  const isErc20 = offer.assetType === ASSET_TYPE_ERC20;
  const isLender = offer.offerType === 0;
  const principalWei = isErc20 && isLender && amountMax > 0n ? amountMax : amount;
  const rateBps = isErc20
    ? isLender
      ? offer.interestRateBps
      : offer.interestRateBpsMax
    : offer.interestRateBps;
  return { principalWei, rateBps };
}

export function isNftRentalLoan(loan: Pick<IndexedLoanLike, 'assetType'>): boolean {
  return isNftAssetType(loan.assetType);
}

interface IndexedLoanLike {
  assetType: number;
}