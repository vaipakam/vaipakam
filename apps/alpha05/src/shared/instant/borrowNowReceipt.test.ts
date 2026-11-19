import { describe, expect, it } from 'vitest';
import { walletDrawCeiling, type BorrowNowReview } from './borrowNow';
import { borrowNowKey } from './borrowNowReview';
import { borrowNowBlocker, borrowNowReceipt } from './borrowNowReceipt';

const A = '0x00000000000000000000000000000000000000aa' as const;
const copy = { text: (k: string) => k, format: (k: string) => k } as never;
const review = (over: Partial<BorrowNowReview>): BorrowNowReview =>
  ({
    terms: { lending: A, collateral: A, amount: 5n, maxRateBps: 500n, termDays: 30, collateralOffered: 10n, allowsPartialRepay: false },
    sources: [],
    searchComplete: true,
    state: { kind: 'no-source' },
    walletPart: 0n,
    allowance: 0n,
    approvalNeeded: false,
    approvalSteps: 0,
    identity: 'x',
    risk: null,
    lif: null,
    readAt: 0,
    ...over,
  }) as BorrowNowReview;

describe('borrow now, a bounded source search (Codex round 8 on #3767)', () => {
  it('says no lender can take it only after every source was searched', () => {
    expect(borrowNowBlocker(review({ state: { kind: 'no-source' } }), null, copy)).toBe('borrowNow.stateNoSource');
    expect(borrowNowBlocker(review({ state: { kind: 'none-found' }, searchComplete: false }), null, copy)).toBe('borrowNow.stateNoneFound');
  });
  it('states on the receipt that the search was bounded, and only then', () => {
    expect(borrowNowReceipt(review({ searchComplete: false }), A, null, copy).consequences.map(String)).toContain('borrowNow.loseSearchBounded');
    expect(borrowNowReceipt(review({}), A, null, copy).consequences.map(String)).not.toContain('borrowNow.loseSearchBounded');
  });
});

describe('borrow now, the wallet-draw ceiling (Codex round 11 on #3767)', () => {
  it('a new allowance that moves the ceiling asks for a new confirmation', () => {
    const before = review({ walletPart: 4n, allowance: 6n });
    const after = review({ walletPart: 4n, allowance: 9n });
    expect(walletDrawCeiling(before)).toBe(6n);
    expect(walletDrawCeiling(after)).toBe(9n);
    expect(borrowNowKey(before)).not.toBe(borrowNowKey(after));
  });
  it('never states a ceiling above the collateral offered', () => {
    expect(walletDrawCeiling(review({ walletPart: 4n, allowance: 50n }))).toBe(10n);
    expect(walletDrawCeiling(review({ walletPart: 4n, allowance: 0n, approvalNeeded: true }))).toBe(4n);
  });
});
