import { parseUnits } from 'viem';
import type { CreateOfferForm } from '../types/offers.js';

export const MIN_OFFER_DURATION_DAYS = 1;
export const MAX_OFFER_DURATION_DAYS = 365;
export const OFFER_DURATION_DEFAULT_DAYS = 30;

export function parseInterestBps(percent: string): bigint {
  const n = Number(percent);
  if (!Number.isFinite(n) || n < 0) throw new Error('Invalid interest rate');
  return BigInt(Math.round(n * 100));
}

export function toCreateOfferPayload(form: CreateOfferForm) {
  if (!form.riskAndTermsConsent) throw new Error('Risk and terms consent required');
  const duration = Number(form.durationDays);
  if (duration < MIN_OFFER_DURATION_DAYS || duration > MAX_OFFER_DURATION_DAYS) {
    throw new Error('Duration out of range');
  }

  const isLender = form.offerType === 'lender';
  const lendingAmount = parseUnits(form.amount || '0', 18);
  const collateralAmount = parseUnits(form.collateralAmount || '0', 18);
  const rateBps = parseInterestBps(form.interestRate || '0');
  const lenderMinPartial = lendingAmount / 10n || 1n;

  return {
    offerType: isLender ? 0 : 1,
    assetType: 0,
    collateralAssetType: 0,
    lendingAsset: form.lendingAsset,
    collateralAsset: form.collateralAsset,
    amount: isLender ? lenderMinPartial : lendingAmount,
    amountMax: isLender ? lendingAmount : 0n,
    interestRateBps: isLender ? rateBps : 0n,
    interestRateBpsMax: isLender ? 0n : rateBps,
    collateralAmount,
    collateralAmountMax: 0n,
    durationDays: BigInt(duration),
    tokenId: 0n,
    collateralTokenId: 0n,
    quantity: 1n,
    collateralQuantity: 0n,
    prepayAsset: '0x0000000000000000000000000000000000000000',
    riskAndTermsConsent: true,
    allowsPartialRepay: false,
    fillMode: 1,
    expiresAt: 0n,
    useFullTermInterest: true,
    periodicInterestCadence: 0,
    allowsParallelSale: false,
    refinanceTargetLoanId: 0n,
  };
}

export function formatBpsAsPercent(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}