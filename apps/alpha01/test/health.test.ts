import { borrowerPrimaryAction, plainHealthLabel } from '@vaipakam/defi-client';
import { describe, expect, it } from 'vitest';

describe('plainHealthLabel', () => {
  it('uses the live min HF floor for the healthy band', () => {
    const min2 = 2n * 10n ** 18n;
    expect(plainHealthLabel(2n * 10n ** 18n, min2).label).toBe('Healthy');
    expect(plainHealthLabel(15n * 10n ** 17n, min2).label).toBe('Needs attention');
    expect(plainHealthLabel(15n * 10n ** 17n).label).toBe('Healthy');
  });
});

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
      borrowerPrimaryAction({
        role: 'borrower',
        loanStatus: 'internal_matched',
        healthTone: 'ok',
        borrowerClaimable: true,
      }).action,
    ).toBe('claim-collateral');
    expect(
      borrowerPrimaryAction({
        role: 'borrower',
        loanStatus: 'internal_matched',
        healthTone: 'ok',
        borrowerClaimable: false,
      }).action,
    ).toBe('none');
    expect(
      borrowerPrimaryAction({
        role: 'borrower',
        loanStatus: 'liquidated',
        healthTone: 'ok',
        borrowerClaimable: true,
      }).action,
    ).toBe('claim-collateral');
    expect(
      borrowerPrimaryAction({
        role: 'borrower',
        loanStatus: 'liquidated',
        healthTone: 'ok',
        borrowerClaimable: false,
      }).action,
    ).toBe('none');
    expect(
      borrowerPrimaryAction({ role: 'borrower', loanStatus: 'settled', healthTone: 'ok' }).action,
    ).toBe('none');
  });

  it('uses rental copy for active NFT rentals', () => {
    expect(
      borrowerPrimaryAction({
        role: 'borrower',
        loanStatus: 'active',
        healthTone: 'ok',
        isRental: true,
      }).label,
    ).toBe('Close rental early');
    expect(
      borrowerPrimaryAction({
        role: 'lender',
        loanStatus: 'repaid',
        healthTone: 'ok',
        isRental: true,
      }).label,
    ).toBe('Claim fees and NFT');
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