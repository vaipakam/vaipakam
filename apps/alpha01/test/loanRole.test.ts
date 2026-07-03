import { loanRoleForWallet, loanRolesForWallet } from '@vaipakam/defi-client';
import type { IndexedLoan } from '@vaipakam/defi-client';
import { describe, expect, it } from 'vitest';

function loan(partial: Partial<IndexedLoan>): IndexedLoan {
  return {
    loanId: 1,
    chainId: 84532,
    status: 'defaulted',
    lender: '0x1111111111111111111111111111111111111111',
    borrower: '0x2222222222222222222222222222222222222222',
    principal: '1000',
    collateralAmount: '2000',
    lendingAsset: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    collateralAsset: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    assetType: 0,
    collateralAssetType: 0,
    interestRateBps: 500,
    durationDays: 30,
    ...partial,
  } as IndexedLoan;
}

describe('loanRoleForWallet', () => {
  it('returns both when the wallet holds lender and borrower NFTs', () => {
    const wallet = '0xcccccccccccccccccccccccccccccccccccccccc';
    const row = loan({
      lenderCurrentOwner: wallet,
      borrowerCurrentOwner: wallet,
    });
    expect(loanRolesForWallet(row, wallet)).toEqual(['borrower', 'lender']);
    expect(loanRoleForWallet(row, wallet)).toBe('both');
  });
});