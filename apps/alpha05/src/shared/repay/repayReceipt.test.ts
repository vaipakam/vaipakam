import { describe, expect, it } from 'vitest';
import { OPEN } from '../eligibility/types';
import type { LoanDetails } from '../positions/loanView';
import { repayReceipt } from './repayReceipt';
import type { RepayReview } from './repayReview';

const copy = { text: (k: string) => k, format: (k: string, v?: Record<string, string>) => `${k}${v?.id ? `#${v.id}` : ''}` } as never;
const A = '0x00000000000000000000000000000000000000aa' as const;

const review: RepayReview = {
  identity: '1:0xaa',
  loanId: 7n,
  loan: { status: 0, principal: 100n, principalAsset: A, collateralAsset: A, collateralAmount: 5n, borrowerTokenId: 2n } as unknown as LoanDetails,
  lenderHolder: A,
  borrowerHolder: A,
  graceEnd: 5_000n,
  borrowerLock: 0,
  refinanceOffer: 0n,
  payoff: { now: 101n, chainNow: 1_000n, atBy: 105n, by: 2_800n },
  capped: false,
  balance: 200n,
  allowance: 0n,
  approvalSteps: 1,
  verdict: OPEN,
  readAt: 1,
};
const lines = (r: RepayReview) => repayReceipt(r, A, null, copy).consequences.map(String);

describe('repayReceipt refinance request', () => {
  it('says nothing when no request was ever recorded', () => {
    expect(lines(review).some((l) => l.startsWith('repay.refinance'))).toBe(false);
  });
  it('names a recorded request, which the repayment ends but leaves posted', () => {
    expect(lines({ ...review, refinanceOffer: 9n })).toContain('repay.refinanceStays#9');
  });
  it('states an unread request as unread', () => {
    expect(lines({ ...review, refinanceOffer: null })).toContain('repay.refinanceUnread');
  });
});
