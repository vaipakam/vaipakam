import { describe, expect, it } from 'vitest';
import { LOCK_SWAP_INTENT, repayVerdict, STATUS_ACTIVE, STATUS_FALLBACK_PENDING, type RepayInputs } from './repay';

const copy = { text: (k: string) => k, format: (k: string) => k } as never;
const PAYER = '0x00000000000000000000000000000000000000aa' as const;
const LENDER = '0x00000000000000000000000000000000000000bb' as const;

const base: RepayInputs = {
  status: STATUS_ACTIVE,
  assetType: 0,
  recordedLender: LENDER,
  lenderHolder: LENDER,
  graceEnd: 2_000n,
  chainNow: 1_000n,
  borrowerLock: 0,
};
const verdict = (over: Partial<RepayInputs>, payer: `0x${string}` = PAYER) => repayVerdict({ ...base, ...over }, payer, copy, 1);

describe('repayVerdict', () => {
  it('is open for anyone but the lender on a running loan inside its grace period', () => {
    expect(verdict({}).state).toBe('open');
  });
  it('refuses the recorded lender and the current lender holder alike', () => {
    expect(verdict({}, LENDER).refusals[0]?.code).toBe('LenderCannotRepayOwnLoan');
    expect(verdict({ lenderHolder: PAYER }).refusals[0]?.code).toBe('LenderCannotRepayOwnLoan');
  });
  it('refuses a running loan past the end of its grace period, and names when it ended', () => {
    const v = verdict({ chainNow: 2_001n });
    expect(v.state).toBe('closed');
    expect(v.refusals[0]?.code).toBe('RepaymentPastGracePeriod');
  });
  it('keeps a loan in fallback open past grace: a full repayment cures it', () => {
    expect(verdict({ status: STATUS_FALLBACK_PENDING, graceEnd: null, chainNow: 9_999n }).state).toBe('open');
  });
  it('holds while a swap-to-repay order is pending on the borrower position', () => {
    expect(verdict({ borrowerLock: LOCK_SWAP_INTENT }).refusals[0]?.code).toBe('LiveIntentCommit');
  });
  it('does not hold for a lender listing (repayment is never held by one)', () => {
    // LockReason.EarlyWithdrawalSale sits on the LENDER token; the borrower
    // token read here is unlocked, and a borrower-side prepay listing is no
    // hold on repayment either.
    expect(verdict({ borrowerLock: 3 }).state).toBe('open');
  });
  it('is unknown, never open, while an input it needs is unread', () => {
    expect(verdict({ lenderHolder: null }).state).toBe('unknown');
    expect(verdict({ borrowerLock: null }).state).toBe('unknown');
    expect(verdict({ graceEnd: null }).state).toBe('unknown');
  });
  it('has nothing to repay on an ended loan, and leaves a rental to a later update', () => {
    expect(verdict({ status: 1 }).refusals[0]?.code).toBe('InvalidLoanStatus');
    expect(verdict({ assetType: 1 }).refusals[0]?.code).toBe('RentalNotHere');
  });
});
