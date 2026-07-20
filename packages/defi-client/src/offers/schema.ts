import { parseUnits } from 'viem';
import type { CreateOfferForm } from '../types/offers.js';

export const MIN_OFFER_DURATION_DAYS = 1;
export const MAX_OFFER_DURATION_DAYS = 365;

/** Bucketed duration presets — frontend convention for better offer matching. */
export const OFFER_DURATION_BUCKETS_DAYS: readonly number[] = [
  7, 14, 30, 60, 90, 180, 365,
] as const;

export const OFFER_DURATION_DEFAULT_DAYS = 30;

/** Mirrors LibVaipakam.MAX_INTEREST_BPS (100% APR protocol cap). */
const MAX_INTEREST_BPS = 10_000n;

/** Mirrors LibVaipakam.LOAN_INITIATION_FEE_BPS — ERC-20 principal path default.
 *  0.2% since the #1352 fee freeze (was 0.1%); keep in sync with the contract
 *  constant so receipts don't understate the upfront borrower haircut when the
 *  live fee-config read is unavailable. */
export const LOAN_INITIATION_FEE_BPS = 20n;

/** Net wallet proceeds after the upfront ERC-20 LIF deduction at accept. */
export function netBorrowProceedsWei(
  principalWei: bigint,
  lifBps: bigint = LOAN_INITIATION_FEE_BPS,
): bigint {
  if (principalWei <= 0n) return 0n;
  const fee = (principalWei * lifBps) / 10_000n;
  return principalWei - fee;
}

export interface OfferPayloadDecimals {
  lending?: number;
  collateral?: number;
}

export function formatDurationBucketLabel(days: number): string {
  if (days === 365) return '1 year';
  return `${days} days`;
}

export function parseInterestBps(percent: string): bigint {
  const n = Number(percent);
  if (!Number.isFinite(n) || n < 0) throw new Error('Invalid interest rate');
  const bps = BigInt(Math.round(n * 100));
  if (bps > MAX_INTEREST_BPS) {
    throw new Error('Interest rate exceeds protocol cap (100% APR)');
  }
  return bps;
}

export function toBorrowerOfferPayload(
  form: CreateOfferForm,
  decimals: OfferPayloadDecimals = {},
) {
  if (form.offerType !== 'borrower') throw new Error('Borrower offer required');
  return toCreateOfferPayload({ ...form, offerType: 'borrower' }, decimals);
}

export function toCreateOfferPayload(
  form: CreateOfferForm,
  decimals: OfferPayloadDecimals = {},
) {
  if (!form.riskAndTermsConsent) throw new Error('Risk and terms consent required');
  const duration = Number(form.durationDays);
  if (duration < MIN_OFFER_DURATION_DAYS || duration > MAX_OFFER_DURATION_DAYS) {
    throw new Error('Duration out of range');
  }

  const lendingDecimals = decimals.lending ?? 18;
  const collateralDecimals = decimals.collateral ?? 18;

  const isLender = form.offerType === 'lender';
  const lendingAmount = parseUnits(form.amount || '0', lendingDecimals);
  const collateralAmount = parseUnits(form.collateralAmount || '0', collateralDecimals);
  const rateBps = parseInterestBps(form.interestRate || '0');
  const lenderMinPartial = lendingAmount / 10n || 1n;

  return {
    offerType: isLender ? 0 : 1,
    assetType: 0,
    collateralAssetType: 0,
    lendingAsset: form.lendingAsset,
    collateralAsset: form.collateralAsset,
    amount: isLender ? lenderMinPartial : lendingAmount,
    amountMax: lendingAmount,
    interestRateBps: isLender ? rateBps : 0n,
    interestRateBpsMax: isLender ? MAX_INTEREST_BPS : rateBps,
    collateralAmount,
    collateralAmountMax: collateralAmount,
    durationDays: BigInt(duration),
    tokenId: 0n,
    collateralTokenId: 0n,
    quantity: 1n,
    collateralQuantity: 0n,
    prepayAsset: '0x0000000000000000000000000000000000000000',
    creatorRiskAndTermsConsent: true,
    allowsPartialRepay: false,
    fillMode: isLender ? 0 : 1,
    expiresAt: 0n,
    allowsPrepayListing: false,
    useFullTermInterest: true,
    periodicInterestCadence: 0,
    allowsParallelSale: false,
    refinanceTargetLoanId: 0n,
  };
}

export function formatBpsAsPercent(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}