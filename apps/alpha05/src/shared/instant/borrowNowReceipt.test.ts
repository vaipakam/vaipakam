import { describe, expect, it } from 'vitest';
import type { BorrowNowReview } from './borrowNow';
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
