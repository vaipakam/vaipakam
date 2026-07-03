import type { IndexedOffer } from '@vaipakam/defi-client';
import {
  collateralLiquidityLabel,
  formatBpsAsPercent,
  formatHealthFactor,
  MIN_HEALTH_FACTOR_1E18,
} from '@vaipakam/defi-client';
import type { ReviewReceiptRow } from '../components/ReviewReceipt';

/** Shared Advanced-mode technical rows for debt-loan borrow accept receipts. */
export function borrowAcceptTechnicalDetails(
  offer: IndexedOffer,
  lifBps: number,
): ReviewReceiptRow[] {
  return [
    {
      label: 'Min health factor at open',
      value: formatHealthFactor(MIN_HEALTH_FACTOR_1E18),
      hint: 'Loans must initiate at or above this floor; liquidation risk rises as HF falls toward 1.0.',
    },
    {
      label: 'Interest rate',
      value: `${formatBpsAsPercent(offer.interestRateBps)} APR · ${offer.durationDays} days`,
    },
    {
      label: 'Loan initiation fee',
      value: formatBpsAsPercent(lifBps),
    },
    {
      label: 'Collateral liquidity class',
      value: collateralLiquidityLabel(offer.collateralAssetType),
    },
    {
      label: 'Principal asset type',
      value: offer.assetType === 0 ? 'ERC-20' : offer.assetType === 1 ? 'ERC-721' : 'ERC-1155',
    },
  ];
}

export function lendFundTechnicalDetails(offer: IndexedOffer): ReviewReceiptRow[] {
  return [
    {
      label: 'Borrower APR',
      value: formatBpsAsPercent(offer.interestRateBpsMax || offer.interestRateBps),
    },
    {
      label: 'Term',
      value: `${offer.durationDays} days`,
    },
    {
      label: 'Collateral liquidity class',
      value: collateralLiquidityLabel(offer.collateralAssetType),
    },
    {
      label: 'Partial repay',
      value: offer.allowsPartialRepay ? 'Allowed' : 'Full repay only',
    },
  ];
}

export function lendCreateTechnicalDetails(rate: string, duration: string): ReviewReceiptRow[] {
  return [
    { label: 'Posted APR ceiling', value: `${rate}%` },
    { label: 'Term', value: `${duration} days` },
    {
      label: 'Matching',
      value: 'Open until accepted or cancelled; on-chain LTV/HF enforced at loan open.',
    },
  ];
}