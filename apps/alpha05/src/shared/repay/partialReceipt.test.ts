import { describe, expect, it } from 'vitest';
import { OPEN } from '../eligibility/types';
import type { LoanDetails } from '../positions/loanView';
import { partialReceipt } from './partialReceipt';
import { minimumPart, type PartialReview } from './partialReview';

const copy = { text: (k: string) => k, format: (k: string) => k } as never;
const A = '0x00000000000000000000000000000000000000aa' as const;

const review: PartialReview = {
  identity: '1:0xaa',
  loanId: 7n,
  loan: { status: 0, principal: 1_000n, principalAsset: A, useFullTermInterest: false } as unknown as LoanDetails,
  lenderHolder: A,
  borrowerHolder: A,
  graceEnd: 9_000n,
  maturity: 8_000n,
  borrowerLock: 0,
  refinanceLive: false,
  amount: 400n,
  floor: 10n,
  amountCheck: { ok: true },
  payoff: { now: 1_010n, chainNow: 1_000n, atBy: 1_012n, by: 2_800n },
  capped: false,
  interestNow: 10n,
  interestBy: 12n,
  interestExact: true,
  totalBy: 412n,
  period: null,
  periodUnread: false,
  balance: 1_000n,
  allowance: 0n,
  approvalSteps: 1,
  verdict: OPEN,
  readAt: 1,
};
const receipt = (r: PartialReview) => partialReceipt(r, null, copy);
const row = (r: PartialReview, label: string) => receipt(r).rows.find((x) => x.label === label)?.value;

describe('partialReceipt', () => {
  it('states the interest as an amount when it is exact', () => {
    expect(row(review, 'partial.rowInterestNow')).toEqual({ kind: 'amount', asset: A, amount: 10n });
    expect(receipt(review).consequences).toContain('partial.interestExact');
  });
  it('states the interest as at most, and why, when it is an upper bound', () => {
    const late = { ...review, interestExact: false };
    expect(row(late, 'partial.rowInterestNow')?.kind).toBe('text');
    expect(receipt(late).consequences).toContain('partial.interestBoundLate');
    const full = { ...late, loan: { ...review.loan, useFullTermInterest: true } };
    expect(receipt(full).consequences).toEqual(expect.arrayContaining(['partial.interestBoundFull', 'partial.fullTermRestarts']));
  });
  it('states the principal left and the approval reaching the upper total', () => {
    expect(row(review, 'partial.rowAfter')).toEqual({ kind: 'amount', asset: A, amount: 600n });
    expect(row(review, 'partial.rowTotalBy')).toEqual({ kind: 'amount', asset: A, amount: 412n });
    expect(receipt(review).consequences).toContain('repay.losePutBack');
  });
  it('names the interest period, or says it is unread', () => {
    const period = { cadence: 1, periodEndAt: 5_000n, graceEndsAt: 6_000n, expected: 20n, paid: 0n, shortfall: 20n, canSettleNow: false };
    expect(receipt({ ...review, period }).consequences).toContain('partial.periodCounts');
    expect(receipt({ ...review, periodUnread: true }).consequences).toContain('partial.periodUnread');
  });
  it('states an unread due date as unknown', () => {
    expect(row({ ...review, maturity: null }, 'partial.rowDue')?.kind).toBe('unknown');
  });
});

describe('minimumPart', () => {
  it('is the protocol product, never below one unit', () => {
    expect(minimumPart(1_000n, 500n)).toBe(50n);
    expect(minimumPart(10n, 100n)).toBe(1n);
  });
});
