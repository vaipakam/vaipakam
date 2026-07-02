import type { IndexedLoan } from '../types/loans.js';

/** Role from current position-NFT holder when indexer provides it. */
export function loanRoleForWallet(
  loan: IndexedLoan,
  wallet: string | null | undefined,
): 'borrower' | 'lender' | 'other' {
  if (!wallet) return 'other';
  const w = wallet.toLowerCase();
  const borrowerOwner = loan.borrowerCurrentOwner?.toLowerCase();
  const lenderOwner = loan.lenderCurrentOwner?.toLowerCase();
  const isBorrower =
    borrowerOwner === w || (!borrowerOwner && loan.borrower.toLowerCase() === w);
  const isLender =
    lenderOwner === w || (!lenderOwner && loan.lender.toLowerCase() === w);
  if (isBorrower) return 'borrower';
  if (isLender) return 'lender';
  return 'other';
}