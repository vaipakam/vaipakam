/**
 * #3615 — a pro-rata pair may match across terms, so the matcher no longer
 * buckets by term and filters pairs with the match core's rule instead.
 */
import { describe, expect, it } from 'vitest';
import { fairPairs } from '../src/fairPairs';
import { offerMatchUnits, partitionByBucket, termsFit, type OfferLite } from '../src/matcher';

const LEND = '0x00000000000000000000000000000000000000c1';
const COLL = '0x00000000000000000000000000000000000000c2';

function offer(id: number, offerType: 0 | 1, durationDays: bigint, useFullTermInterest: boolean): OfferLite {
  return {
    id: BigInt(id), creator: `0x${(0x100 + id).toString(16).padStart(40, '0')}`, offerType, accepted: false,
    assetType: 0, collateralAssetType: 0, lendingAsset: LEND, collateralAsset: COLL, durationDays,
    amount: 100n, amountMax: 100n, amountFilled: 0n, interestRateBpsMax: 1000n, fillMode: 0,
    useFullTermInterest, allowsPartialRepay: false,
  } as unknown as OfferLite;
}

describe('termsFit', () => {
  it('equal terms always fit', () => {
    expect(termsFit(offer(1, 0, 30n, true), offer(2, 1, 30n, true))).toBe(true);
    expect(termsFit(offer(1, 0, 30n, false), offer(2, 1, 30n, true))).toBe(true);
  });
  it('a pro-rata pair fits when the borrower term is below the lender term', () => {
    expect(termsFit(offer(1, 0, 60n, false), offer(2, 1, 30n, false))).toBe(true);
  });
  it('a borrower term above the lender term never fits', () => {
    expect(termsFit(offer(1, 0, 30n, false), offer(2, 1, 60n, false))).toBe(false);
  });
  it('different terms need both offers pro-rata', () => {
    expect(termsFit(offer(1, 0, 60n, true), offer(2, 1, 30n, false))).toBe(false);
    expect(termsFit(offer(1, 0, 60n, false), offer(2, 1, 30n, true))).toBe(false);
  });
});

describe('the walk pairs offers of different terms', () => {
  it('puts both terms in one bucket and yields only the pairs that fit', () => {
    const lender = offer(1, 0, 60n, false);
    const shorter = offer(2, 1, 30n, false);
    const longer = offer(3, 1, 90n, false);
    const fullTerm = offer(4, 1, 30n, true);
    const { lenders, borrowers } = partitionByBucket([lender, shorter, longer, fullTerm]);
    expect(lenders.size).toBe(1);
    expect(borrowers.size).toBe(1);
    const pairs = [...fairPairs(offerMatchUnits(lenders, borrowers, 0), { skip: (l, b) => !termsFit(l, b) })];
    expect(pairs.map(([l, b]) => `${l.id}-${b.id}`)).toEqual(['1-2']);
  });
});
