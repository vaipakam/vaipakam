import type { IndexedLoan } from '../types/loans.js';

export type LoanWalletRole = 'borrower' | 'lender' | 'both' | 'other';

/** All holder roles for a wallet on this loan (current-holder NFT semantics). */
export function loanRolesForWallet(
  loan: IndexedLoan,
  wallet: string | null | undefined,
): ('borrower' | 'lender')[] {
  if (!wallet) return [];
  const w = wallet.toLowerCase();
  const borrowerOwner = loan.borrowerCurrentOwner?.toLowerCase();
  const lenderOwner = loan.lenderCurrentOwner?.toLowerCase();
  const roles: ('borrower' | 'lender')[] = [];
  if (borrowerOwner === w || (!borrowerOwner && loan.borrower.toLowerCase() === w)) {
    roles.push('borrower');
  }
  if (lenderOwner === w || (!lenderOwner && loan.lender.toLowerCase() === w)) {
    roles.push('lender');
  }
  return roles;
}

/** Role from current position-NFT holder when indexer provides it. */
export function loanRoleForWallet(
  loan: IndexedLoan,
  wallet: string | null | undefined,
): LoanWalletRole {
  const roles = loanRolesForWallet(loan, wallet);
  if (roles.length === 2) return 'both';
  if (roles.length === 1) return roles[0]!;
  return 'other';
}