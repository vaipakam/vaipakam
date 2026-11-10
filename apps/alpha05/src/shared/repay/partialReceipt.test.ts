import { describe, expect, it } from 'vitest';
import { OPEN } from '../eligibility/types';
import type { LoanDetails } from '../positions/loanView';
import { partialReceipt } from './partialReceipt';
import { minimumPart, partialBlockers, partialChanged, partialFunds, type PartialReview } from './partialReview';

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
  payoff: { now: 1_010n, chainNow: 1_000n, chainReadAt: 0, atBy: 1_012n, by: 2_800n },
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

describe('partialChanged', () => {
  it('reopens on any loan field the receipt states, the due date included', () => {
    expect(partialChanged(review, { ...review, loan: { ...review.loan, useFullTermInterest: true } }, copy)).toBe('repay.changedLoan');
    expect(partialChanged(review, { ...review, maturity: 9_500n }, copy)).toBe('repay.changedLoan');
    expect(partialChanged(review, { ...review, allowance: review.allowance + 1n }, copy)).toBe('repay.changedFunds');
    expect(partialChanged(review, review, copy)).toBeNull();
  });
});

describe('partialReceipt put-back prompts', () => {
  it('states the put-back apart from the payment prompts', () => {
    expect(receipt(review).prompts).toBe(2);
    expect(receipt(review).afterPrompts).toBe(1);
    expect(receipt({ ...review, approvalSteps: 0 }).afterPrompts).toBe(0);
  });
});

describe('partialFunds', () => {
  it('blocks only a proven shortfall: the part alone, or the part plus an exact interest', () => {
    expect(partialFunds({ ...review, balance: 410n })).toBe('enough');
    expect(partialFunds({ ...review, balance: 405n })).toBe('short');
    expect(partialFunds({ ...review, balance: 399n, interestExact: false })).toBe('short');
    expect(partialFunds({ ...review, balance: 405n, interestExact: false })).toBe('unproven');
  });
  it('lets an unproven balance through to the dry run, stating it on the receipt', () => {
    const r = { ...review, balance: 405n, interestExact: false };
    expect(partialBlockers(r, copy, String)).toEqual([]);
    expect(receipt(r).consequences.some((c) => (typeof c === 'string' ? c : JSON.stringify(c)).includes('partial.balanceUnproven'))).toBe(true);
    expect(partialBlockers({ ...review, balance: 399n, interestExact: false }, copy, String)).toEqual(['partial.shortPart']);
    expect(partialBlockers({ ...review, balance: 405n }, copy, String)).toEqual(['partial.short']);
  });
  it('states that who receives the payment is settled at confirmation', () => {
    expect(receipt(review).consequences).toContain('partial.lenderRouting');
  });
});
