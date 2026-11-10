import { describe, expect, it } from 'vitest';
import { OPEN } from '../eligibility/types';
import type { LoanDetails } from '../positions/loanView';
import { changedBetween, promptCount, reviewBlockers, type RepayReview, putBackPromptCount } from './repayReview';

const copy = { text: (k: string) => k } as never;
const A = '0x00000000000000000000000000000000000000aa' as const;

const review: RepayReview = {
  identity: '1:0xaa',
  loanId: 7n,
  loan: { status: 0, principal: 100n, principalAsset: A } as unknown as LoanDetails,
  lenderHolder: A,
  borrowerHolder: A,
  graceEnd: 5_000n,
  maturity: 4_000n,
  borrowerLock: 0,
  refinance: { offerId: 0n, live: false },
  payoff: { now: 101n, chainNow: 1_000n, chainReadAt: 0, atBy: 105n, by: 2_800n },
  capped: false,
  balance: 200n,
  allowance: 0n,
  approvalSteps: 1,
  verdict: OPEN,
  readAt: 1,
};

describe('changedBetween', () => {
  it('does not count the payoff growing by the second as a change', () => {
    expect(changedBetween(review, { ...review, payoff: { ...review.payoff, now: 103n, chainNow: 1_012n } }, copy)).toBeNull();
  });
  it('reopens on a different figure at the kept moment, or a moved moment', () => {
    expect(changedBetween(review, { ...review, payoff: { ...review.payoff, atBy: 104n } }, copy)).toBe('repay.changedPayoff');
    expect(changedBetween(review, { ...review, payoff: { ...review.payoff, by: 3_000n } }, copy)).toBe('repay.changedPayoff');
  });
  it('reopens when any loan field the receipt states moved, a withdrawn collateral included', () => {
    expect(changedBetween(review, { ...review, loan: { ...review.loan, collateralAmount: 1n } }, copy)).toBe('repay.changedLoan');
    expect(changedBetween(review, { ...review, loan: { ...review.loan, collateralQuantity: 3n } }, copy)).toBe('repay.changedLoan');
    expect(changedBetween(review, { ...review, loan: { ...review.loan, useFullTermInterest: true } }, copy)).toBe('repay.changedLoan');
  });
  it('reopens when a holder, the approval steps or the verdict moved', () => {
    expect(changedBetween(review, { ...review, borrowerHolder: null }, copy)).toBe('repay.changedHolders');
    // A moved due date moves the grace clock the review shows.
    expect(changedBetween(review, { ...review, maturity: 4_001n }, copy)).toBe('repay.changedHolders');
    expect(changedBetween(review, { ...review, refinance: { offerId: 9n, live: true } }, copy)).toBe('repay.changedHolders');
    expect(changedBetween(review, { ...review, refinance: { offerId: 0n, live: true } }, copy)).toBe('repay.changedHolders');
    expect(changedBetween(review, { ...review, approvalSteps: 0 }, copy)).toBe('repay.changedFunds');
    expect(changedBetween(review, { ...review, allowance: review.allowance + 1n }, copy)).toBe('repay.changedFunds');
    expect(changedBetween(review, { ...review, verdict: { ...OPEN, state: 'unknown' } }, copy)).toBe('repay.changedVerdict');
  });
});

describe('reviewBlockers and promptCount', () => {
  it('blocks a wallet short of the payoff now, naming the shortfall', () => {
    expect(reviewBlockers({ ...review, balance: 90n }, (s) => `short ${s}`)).toEqual(['short 11']);
    expect(reviewBlockers(review, (s) => `short ${s}`)).toEqual([]);
  });
  it('counts the approval steps and the repayment', () => {
    expect(promptCount(review)).toBe(2);
    expect(promptCount({ ...review, approvalSteps: 0 })).toBe(1);
  });
  it('counts the put-back prompts that may follow apart: none without an approval, up to two through zero', () => {
    expect(putBackPromptCount({ ...review, approvalSteps: 0 })).toBe(0);
    expect(putBackPromptCount(review)).toBe(1);
    expect(putBackPromptCount({ ...review, approvalSteps: 2 })).toBe(2);
  });
});
