import { parseUnits } from 'viem';
import {
  ASSET_TYPE_ERC20,
  ASSET_TYPE_ERC721,
  ASSET_TYPE_ERC1155,
  type OfferAssetKind,
} from '../types/offers.js';
import type { OfferPayloadDecimals } from './schema.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface NftRentalListForm {
  nftAssetKind: Extract<OfferAssetKind, 'erc721' | 'erc1155'>;
  nftContract: string;
  tokenId: string;
  quantity: string;
  dailyFee: string;
  prepayAsset: string;
  durationDays: string;
  riskAndTermsConsent: boolean;
}

export interface NftRentalDemandForm {
  nftAssetKind: Extract<OfferAssetKind, 'erc721' | 'erc1155'>;
  nftContract: string;
  tokenId: string;
  quantity: string;
  maxDailyFee: string;
  prepayAsset: string;
  durationDays: string;
  riskAndTermsConsent: boolean;
}

function kindToEnum(kind: OfferAssetKind): 0 | 1 | 2 {
  if (kind === 'erc20') return ASSET_TYPE_ERC20;
  if (kind === 'erc721') return ASSET_TYPE_ERC721;
  return ASSET_TYPE_ERC1155;
}

function parseDurationDays(raw: string): bigint {
  const duration = Number(raw);
  if (!Number.isFinite(duration) || duration < 1 || duration > 365) {
    throw new Error('Duration out of range');
  }
  return BigInt(duration);
}

/** ERC-1155 accept still grants one unit of use rights — block multi-quantity until wired. */
function assertErc1155RentalQuantity(assetType: number, quantity: bigint) {
  if (assetType === ASSET_TYPE_ERC1155 && quantity !== 1n) {
    throw new Error('ERC-1155 rentals currently support quantity 1 only');
  }
}

/** Lender lists an NFT for rent (N1 / PF-042 / PF-043). */
export function toNftRentalLenderPayload(
  form: NftRentalListForm,
  decimals: OfferPayloadDecimals = {},
) {
  if (!form.riskAndTermsConsent) throw new Error('Risk and terms consent required');
  const prepayDecimals = decimals.lending ?? 18;
  const dailyFeeWei = parseUnits(form.dailyFee || '0', prepayDecimals);
  if (dailyFeeWei <= 0n) throw new Error('Daily fee must be positive');

  const durationDays = parseDurationDays(form.durationDays);
  const assetType = kindToEnum(form.nftAssetKind);
  const prepayAsset = form.prepayAsset || ZERO_ADDRESS;
  if (prepayAsset === ZERO_ADDRESS) throw new Error('Prepay asset required');
  const quantity = BigInt(form.quantity || '1');
  assertErc1155RentalQuantity(assetType, quantity);

  return {
    offerType: 0 as const,
    assetType,
    collateralAssetType: ASSET_TYPE_ERC20,
    lendingAsset: form.nftContract,
    collateralAsset: prepayAsset,
    amount: dailyFeeWei,
    amountMax: dailyFeeWei,
    interestRateBps: 0n,
    interestRateBpsMax: 0n,
    collateralAmount: 0n,
    collateralAmountMax: 0n,
    durationDays,
    tokenId: BigInt(form.tokenId || '0'),
    collateralTokenId: 0n,
    quantity,
    collateralQuantity: 0n,
    prepayAsset,
    creatorRiskAndTermsConsent: true,
    allowsPartialRepay: false,
    fillMode: 0,
    expiresAt: 0n,
    allowsPrepayListing: false,
    useFullTermInterest: false,
    periodicInterestCadence: 0,
    allowsParallelSale: false,
    refinanceTargetLoanId: 0n,
  };
}

/** Renter posts a rental request when no listing fits (N2 / PF-044). */
export function toNftRentalBorrowerDemandPayload(
  form: NftRentalDemandForm,
  decimals: OfferPayloadDecimals = {},
) {
  if (!form.riskAndTermsConsent) throw new Error('Risk and terms consent required');
  const prepayDecimals = decimals.lending ?? 18;
  const dailyFeeWei = parseUnits(form.maxDailyFee || '0', prepayDecimals);
  if (dailyFeeWei <= 0n) throw new Error('Daily fee must be positive');

  const durationDays = parseDurationDays(form.durationDays);
  const assetType = kindToEnum(form.nftAssetKind);
  const prepayAsset = form.prepayAsset || ZERO_ADDRESS;
  if (prepayAsset === ZERO_ADDRESS) throw new Error('Prepay asset required');
  const quantity = BigInt(form.quantity || '1');
  assertErc1155RentalQuantity(assetType, quantity);

  return {
    offerType: 1 as const,
    assetType,
    collateralAssetType: ASSET_TYPE_ERC20,
    lendingAsset: form.nftContract,
    collateralAsset: prepayAsset,
    amount: dailyFeeWei,
    amountMax: dailyFeeWei,
    interestRateBps: 0n,
    interestRateBpsMax: 0n,
    collateralAmount: 0n,
    collateralAmountMax: 0n,
    durationDays,
    tokenId: BigInt(form.tokenId || '0'),
    collateralTokenId: 0n,
    quantity,
    collateralQuantity: 0n,
    prepayAsset,
    creatorRiskAndTermsConsent: true,
    allowsPartialRepay: false,
    fillMode: 0,
    expiresAt: 0n,
    allowsPrepayListing: false,
    useFullTermInterest: false,
    periodicInterestCadence: 0,
    allowsParallelSale: false,
    refinanceTargetLoanId: 0n,
  };
}