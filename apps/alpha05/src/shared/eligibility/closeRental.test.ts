import { describe, expect, it } from 'vitest';
import { closeRentalVerdict, type CloseRentalInputs } from './closeRental';

const copy = { text: (k: string) => k, format: (k: string) => k } as never;
const RENTER = '0x00000000000000000000000000000000000000aa' as const;
const OTHER = '0x00000000000000000000000000000000000000bb' as const;

const base: CloseRentalInputs = { status: 0, assetType: 1, borrowerHolder: RENTER, graceEnd: 2_000n, chainNow: 1_000n };
const verdict = (over: Partial<CloseRentalInputs>, caller: `0x${string}` = RENTER) => closeRentalVerdict({ ...base, ...over }, caller, copy, 1);

describe('closeRentalVerdict', () => {
  it('is open to the renter position holder on a running rental inside its grace period', () => {
    expect(verdict({}).state).toBe('open');
    expect(verdict({ assetType: 2 }).state).toBe('open');
    // At the very end of the grace period it is still accepted.
    expect(verdict({ chainNow: 2_000n }).state).toBe('open');
  });
  it('refuses anyone who does not hold the renter position', () => {
    expect(verdict({}, OTHER).refusals[0]?.code).toBe('NotBorrower');
  });
  it('refuses a close past the end of the grace period', () => {
    expect(verdict({ chainNow: 2_001n }).refusals[0]?.code).toBe('RepaymentPastGracePeriod');
  });
  it('has nothing to close on a loan or on an ended rental', () => {
    expect(verdict({ assetType: 0 }).refusals[0]?.code).toBe('NotARental');
    expect(verdict({ status: 1 }).refusals[0]?.code).toBe('InvalidLoanStatus');
  });
  it('is unknown, never open, while an input it needs is unread', () => {
    expect(verdict({ borrowerHolder: null }).state).toBe('unknown');
    expect(verdict({ graceEnd: null }).state).toBe('unknown');
  });
});
