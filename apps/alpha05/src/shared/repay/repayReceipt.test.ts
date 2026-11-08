import { maxUint256 } from 'viem';
import { describe, expect, it } from 'vitest';
import { OPEN } from '../eligibility/types';
import type { LoanDetails } from '../positions/loanView';
import { repayReceipt } from './repayReceipt';
import type { RepayReview } from './repayReview';

const copy = {
  text: (k: string) => k,
  format: (k: string, v?: Record<string, string>) => `${k}${v?.id ? `#${v.id}` : ''}${v?.prior ? `<${v.prior}` : ''}`,
} as never;
const A = '0x00000000000000000000000000000000000000aa' as const;

const review: RepayReview = {
  identity: '1:0xaa',
  loanId: 7n,
  loan: {
    status: 0,
    principal: 100n,
    principalAsset: A,
    collateralAsset: A,
    collateralAssetType: 0,
    collateralAmount: 5n,
    collateralTokenId: 0n,
    collateralQuantity: 0n,
    borrowerTokenId: 2n,
  } as unknown as LoanDetails,
  lenderHolder: A,
  borrowerHolder: A,
  graceEnd: 5_000n,
  borrowerLock: 0,
  refinance: { offerId: 0n, live: false },
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
    expect(lines({ ...review, refinance: { offerId: 9n, live: true } })).toContain('repay.refinanceStays#9');
  });
  it('says nothing of a recorded request that no longer stands (cancelled, taken or expired)', () => {
    expect(lines({ ...review, refinance: { offerId: 9n, live: false } }).some((l) => l.startsWith('repay.refinance'))).toBe(false);
  });
  it('states an unread request as unread', () => {
    expect(lines({ ...review, refinance: null })).toContain('repay.refinanceUnread');
  });
});

describe('repayReceipt approval', () => {
  const approvalRow = (r: RepayReview) => {
    const row = repayReceipt(r, A, null, copy).rows.find((x) => x.label === 'repay.rowApproval');
    return row && row.value.kind === 'text' ? row.value.text : null;
  };
  it('raises a short approval to exactly the reviewed maximum', () => {
    expect(approvalRow(review)).toBe('repay.approvalNeeded');
  });
  it('lowers a larger approval to exactly the reviewed maximum, since the repayment takes no maximum of its own', () => {
    expect(approvalRow({ ...review, allowance: 500n })).toMatch(/^repay\.approvalLower</);
  });
  it('names an unlimited approval as unlimited, where it is lowered and where it is put back', () => {
    const r = { ...review, allowance: maxUint256 };
    expect(approvalRow(r)).toBe('repay.approvalLower<repay.unlimited');
    expect(lines(r)).toContain('repay.losePutBack');
  });
});

describe('repayReceipt late confirmation', () => {
  it('says the approval caps the amount, not the time', () => {
    expect(lines(review)).toContain('repay.loseLate');
    expect(lines(review)).not.toContain('repay.loseSame');
  });
  it('says a figure that did not grow leaves a later confirmation free to go through', () => {
    expect(lines({ ...review, payoff: { ...review.payoff, atBy: review.payoff.now } })).toContain('repay.loseSame');
  });
  it('names the grace end instead when the window reaches it', () => {
    const l = lines({ ...review, capped: true, payoff: { ...review.payoff, atBy: review.payoff.now } });
    expect(l).toContain('repay.loseGraceEnds');
    expect(l).not.toContain('repay.loseSame');
  });
});
