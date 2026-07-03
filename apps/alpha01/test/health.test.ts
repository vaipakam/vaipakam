import { borrowerPrimaryAction } from '@vaipakam/defi-client';
import { describe, expect, it } from 'vitest';

describe('borrowerPrimaryAction', () => {
  it('offers borrower claim on terminal recoverable statuses', () => {
    expect(
      borrowerPrimaryAction({ role: 'borrower', loanStatus: 'repaid', healthTone: 'ok' }).action,
    ).toBe('claim-collateral');
    expect(
      borrowerPrimaryAction({
        role: 'borrower',
        loanStatus: 'defaulted',
        healthTone: 'ok',
        borrowerClaimable: true,
      }).action,
    ).toBe('claim-collateral');
    expect(
      borrowerPrimaryAction({
        role: 'borrower',
        loanStatus: 'defaulted',
        healthTone: 'ok',
        borrowerClaimable: false,
      }).action,
    ).toBe('none');
    expect(
      borrowerPrimaryAction({ role: 'borrower', loanStatus: 'internal_matched', healthTone: 'ok' })
        .action,
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
      borrowerPrimaryAction({ role: 'lender', loanStatus: 'fallback_pending', healthTone: 'ok' })
        .action,
    ).toBe('claim-lender');
    expect(
      borrowerPrimaryAction({ role: 'lender', loanStatus: 'internal_matched', healthTone: 'ok' })
        .action,
    ).toBe('claim-lender');
    expect(
      borrowerPrimaryAction({ role: 'lender', loanStatus: 'settled', healthTone: 'ok' }).action,
    ).toBe('none');
  });
});