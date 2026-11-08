import { describe, expect, it } from 'vitest';
import { STATUS_ACTIVE, STATUS_FALLBACK_PENDING, LOCK_SWAP_INTENT } from './repay';
import { checkPartialAmount, LOCK_PRECLOSE_OFFSET, partialRepayVerdict, type PartialRepayInputs } from './partialRepay';

const copy = { text: (k: string) => k, format: (k: string) => k } as never;
const BORROWER = '0x00000000000000000000000000000000000000aa' as const;
const OTHER = '0x00000000000000000000000000000000000000bb' as const;

const base: PartialRepayInputs = {
  status: STATUS_ACTIVE,
  assetType: 0,
  allowsPartialRepay: true,
  borrowerHolder: BORROWER,
  graceEnd: 2_000n,
  chainNow: 1_000n,
  borrowerLock: 0,
  refinanceLive: false,
};
const verdict = (over: Partial<PartialRepayInputs>, payer: `0x${string}` = BORROWER) => partialRepayVerdict({ ...base, ...over }, payer, copy, 1);
const code = (over: Partial<PartialRepayInputs>, payer?: `0x${string}`) => verdict(over, payer).refusals[0]?.code;

describe('partialRepayVerdict', () => {
  it('is open to the borrower holder on a running loan that allows it', () => {
    expect(verdict({}).state).toBe('open');
  });
  it('is the borrower holder’s alone', () => {
    expect(code({}, OTHER)).toBe('NotBorrower');
  });
  it('refuses a loan in fallback (full repayment only) and an ended loan', () => {
    expect(verdict({ status: STATUS_FALLBACK_PENDING }).refusals[0]?.reason).toBe('partial.fallback');
    expect(code({ status: 1 })).toBe('InvalidLoanStatus');
  });
  it('refuses a loan whose terms do not allow it, and a rental', () => {
    expect(code({ allowsPartialRepay: false })).toBe('PartialRepayNotAllowed');
    expect(code({ assetType: 1 })).toBe('RentalNotHere');
  });
  it('refuses past grace, a pending swap order, a live refinance request and a live offset', () => {
    expect(code({ chainNow: 2_001n })).toBe('RepaymentPastGracePeriod');
    expect(code({ borrowerLock: LOCK_SWAP_INTENT })).toBe('LiveIntentCommit');
    expect(code({ refinanceLive: true })).toBe('RefinanceRequestLive');
    expect(code({ borrowerLock: LOCK_PRECLOSE_OFFSET })).toBe('OffsetLive');
  });
  it('is unknown while an input it needs is unread', () => {
    expect(verdict({ borrowerHolder: null }).state).toBe('unknown');
    expect(verdict({ graceEnd: null }).state).toBe('unknown');
    expect(verdict({ refinanceLive: null }).state).toBe('unknown');
    expect(verdict({ borrowerLock: null }).state).toBe('unknown');
  });
});

describe('checkPartialAmount', () => {
  it('takes at least the minimum part and less than the whole principal', () => {
    expect(checkPartialAmount(10n, 100n, 10n)).toEqual({ ok: true });
    expect(checkPartialAmount(99n, 100n, 10n)).toEqual({ ok: true });
    expect(checkPartialAmount(9n, 100n, 10n)).toEqual({ ok: false, why: 'below-floor' });
    expect(checkPartialAmount(100n, 100n, 10n)).toEqual({ ok: false, why: 'whole' });
    expect(checkPartialAmount(0n, 100n, 0n)).toEqual({ ok: false, why: 'zero' });
    expect(checkPartialAmount(5n, 100n, null)).toEqual({ ok: false, why: 'floor-unread' });
  });
});
