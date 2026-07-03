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
  minHf1e18: bigint = MIN_HEALTH_FACTOR_1E18,
): ReviewReceiptRow[] {
  return [
    {
      label: 'Min health factor at open',
      value: formatHealthFactor(minHf1e18),
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
      value: collateralLiquidityLabel(offer.collateralLiquidity, offer.collateralAssetType),
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
      value: collateralLiquidityLabel(offer.collateralLiquidity, offer.collateralAssetType),
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

export function borrowRequestTechnicalDetails(
  opts: {
    maxRate: string;
    duration: string;
    lifBps: number;
  },
  minHf1e18: bigint = MIN_HEALTH_FACTOR_1E18,
): ReviewReceiptRow[] {
  return [
    { label: 'Max APR', value: `${opts.maxRate}%` },
    { label: 'Term', value: `${opts.duration} days` },
    { label: 'Loan initiation fee (at match)', value: formatBpsAsPercent(opts.lifBps) },
    {
      label: 'Min health factor at open',
      value: formatHealthFactor(minHf1e18),
    },
    {
      label: 'Matching',
      value: 'Open until accepted or cancelled; collateral locks at post time.',
    },
  ];
}

/** Compact rows for Advanced-mode offer browse cards. */
export function offerBrowseTechnicalRows(offer: IndexedOffer): { label: string; value: string }[] {
  const amount = BigInt(offer.amount?.trim() || '0');
  const amountMax = BigInt(offer.amountMax?.trim() || '0');
  const rows: { label: string; value: string }[] = [
    { label: 'Offer ID', value: `#${offer.offerId}` },
    {
      label: 'Collateral class',
      value: collateralLiquidityLabel(offer.collateralLiquidity, offer.collateralAssetType),
    },
    {
      label: 'Partial repay',
      value: offer.allowsPartialRepay ? 'Allowed' : 'Full repay only',
    },
  ];
  if (amountMax > amount) {
    rows.unshift({ label: 'Principal range', value: 'Partial fill enabled' });
  }
  if (offer.interestRateBpsMax > offer.interestRateBps) {
    rows.push({
      label: 'Rate range',
      value: `${formatBpsAsPercent(offer.interestRateBps)} – ${formatBpsAsPercent(offer.interestRateBpsMax)}`,
    });
  }
  return rows;
}