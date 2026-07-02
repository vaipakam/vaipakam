import { borrowerPrimaryAction } from '@vaipakam/defi-client';
import { describe, expect, it } from 'vitest';

describe('borrowerPrimaryAction', () => {
  it('offers borrower claim only on repaid loans', () => {
    expect(
      borrowerPrimaryAction({ role: 'borrower', loanStatus: 'repaid', healthTone: 'ok' }).action,
    ).toBe('claim-collateral');
    expect(
      borrowerPrimaryAction({ role: 'borrower', loanStatus: 'settled', healthTone: 'ok' }).action,
    ).toBe('none');
  });

  it('offers lender claim on terminal recoverable statuses', () => {
    expect(
      borrowerPrimaryAction({ role: 'lender', loanStatus: 'defaulted', healthTone: 'ok' }).action,
    ).toBe('claim-lender');
    expect(
      borrowerPrimaryAction({ role: 'lender', loanStatus: 'settled', healthTone: 'ok' }).action,
    ).toBe('none');
  });
});