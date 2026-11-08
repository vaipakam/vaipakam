import { describe, expect, it } from 'vitest';
import { OPEN } from '../eligibility/types';
import type { LoanDetails } from '../positions/loanView';
import { addReceipt } from './addReceipt';
import { addBlockers, addChanged, addPromptCount, type AddReview } from './addReview';

const copy = { text: (k: string) => k, format: (k: string, v?: Record<string, string>) => (v?.amount ? `${k}#${v.amount}` : k) } as never;
const A = '0x00000000000000000000000000000000000000aa' as const;

const review: AddReview = {
  identity: '1:0xaa',
  loanId: 7n,
  amount: 50n,
  loan: { status: 0, assetType: 0, collateralAsset: A, collateralAmount: 100n, principal: 10n, principalAsset: A, borrowerTokenId: 2n } as unknown as LoanDetails,
  borrowerHolder: A,
  borrowerLock: 0,
  assetPaused: false,
  collateralLiquid: true,
  healthFactor: 2n * 10n ** 18n,
  ltvBps: 4000n,
  paused: false,
  balance: 80n,
  allowance: 0n,
  approvalSteps: 1,
  amountCheck: { ok: true },
  verdict: OPEN,
  readAt: 1,
};
const lines = (r: AddReview) => addReceipt(r, null, copy).consequences.map(String);

describe('addReceipt', () => {
  it('states the cure only for a loan in fallback', () => {
    expect(lines(review)).not.toContain('addColl.fallbackCure');
    expect(lines({ ...review, loan: { ...review.loan, status: 4 } })).toContain('addColl.fallbackCure');
  });
  it('states the pause posture in every case', () => {
    expect(lines(review)).toContain('addColl.pauseOpen');
    expect(lines({ ...review, paused: true })).toContain('addColl.pausedOpen');
    expect(lines({ ...review, paused: null })).toContain('addColl.pauseUnread');
  });
  it('promises a put-back only when it approves', () => {
    expect(lines(review)).toContain('addColl.approvalBack');
    expect(lines({ ...review, approvalSteps: 0 })).not.toContain('addColl.approvalBack');
  });
  it('states an unread health factor as unknown', () => {
    const hf = addReceipt({ ...review, healthFactor: null }, null, copy).rows.find((r) => r.label === 'addColl.rowHfNow')?.value;
    expect(hf?.kind).toBe('unknown');
  });
});

describe('addChanged and addBlockers', () => {
  it('reopens on a stated loan field, a holder, the allowance or the verdict, not on the health factor', () => {
    expect(addChanged(review, { ...review, loan: { ...review.loan, collateralAmount: 90n } }, copy)).toBe('repay.changedLoan');
    expect(addChanged(review, { ...review, borrowerLock: 4 }, copy)).toBe('repay.changedHolders');
    expect(addChanged(review, { ...review, allowance: 1n }, copy)).toBe('repay.changedFunds');
    expect(addChanged(review, { ...review, verdict: { ...OPEN, state: 'unknown' } }, copy)).toBe('repay.changedVerdict');
    expect(addChanged(review, { ...review, healthFactor: 3n * 10n ** 18n, ltvBps: 3000n }, copy)).toBeNull();
  });
  it('blocks a wallet short of the amount, naming the shortfall', () => {
    expect(addBlockers({ ...review, amountCheck: { ok: false, why: 'over-balance' }, balance: 30n }, (s) => `short ${s}`)).toEqual(['short 20']);
    expect(addBlockers(review, (s) => `short ${s}`)).toEqual([]);
  });
  it('counts the approval steps and the top-up', () => {
    expect(addPromptCount(review)).toBe(2);
    expect(addPromptCount({ ...review, approvalSteps: 0 })).toBe(1);
  });
});
