/**
 * #3619 — the keeper's intent pre-filter mirrors the protocol's lifecycle
 * rule (`LibIntentTerms.lifecycleVerdict`): pro-rata interest only from an
 * intent that opted in, partial repayment only on pro-rata interest.
 */
import { describe, expect, it } from 'vitest';
import { borrowerFitsIntent, type LenderIntentSummary, type OfferLite } from '../src/matcher';

const LEND = '0x00000000000000000000000000000000000000c1';
const COLL = '0x00000000000000000000000000000000000000c2';

function intent(acceptsProRata: boolean): LenderIntentSummary {
  return {
    owner: '0x00000000000000000000000000000000000000aa', lendingAsset: LEND, collateralAsset: COLL, slot: 0,
    maxExposure: 1000n, minRateBps: 100n, maxInitLtvBps: 8000, maxDurationDays: 365, minFillAmount: 1n,
    requiresKeeperAuth: false, livePrincipal: 0n, availableCapital: 1000n, lendUntil: 0n, acceptsProRata,
  } as LenderIntentSummary;
}

function borrower(useFullTermInterest: boolean, allowsPartialRepay: boolean): OfferLite {
  return {
    id: 1n, creator: '0x00000000000000000000000000000000000000bb', offerType: 1, accepted: false,
    assetType: 0, collateralAssetType: 0, lendingAsset: LEND, collateralAsset: COLL, durationDays: 30n,
    amount: 100n, amountMax: 100n, amountFilled: 0n, interestRateBpsMax: 1000n, fillMode: 0,
    useFullTermInterest, allowsPartialRepay,
  } as unknown as OfferLite;
}

describe('borrowerFitsIntent lifecycle rule', () => {
  it('fills full-term, full-repay requests either way', () => {
    expect(borrowerFitsIntent(intent(false), borrower(true, false))).toBe(true);
    expect(borrowerFitsIntent(intent(true), borrower(true, false))).toBe(true);
  });
  it('fills pro-rata requests only for an intent that opted in', () => {
    expect(borrowerFitsIntent(intent(false), borrower(false, false))).toBe(false);
    expect(borrowerFitsIntent(intent(true), borrower(false, false))).toBe(true);
    expect(borrowerFitsIntent(intent(true), borrower(false, true))).toBe(true);
  });
  it('never fills partial repayment on full-term interest', () => {
    expect(borrowerFitsIntent(intent(true), borrower(true, true))).toBe(false);
    expect(borrowerFitsIntent(intent(false), borrower(true, true))).toBe(false);
  });
});
