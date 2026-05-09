import { useMemo } from 'react';
import { useLogIndex } from './useLogIndex';

export interface UserStats {
  uniqueWallets: number;
  lenderWallets: number;
  borrowerWallets: number;
  bothSides: number;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Derives aggregate unique-user counts from the event-backed loan index.
 * "Unique wallet" = any address that has participated in at least one loan
 * as lender or borrower. Offer creators are not counted separately because
 * creators who never transact can't be distinguished from probing bots
 * without further on-chain evidence.
 */
export function useUserStats(): { stats: UserStats | null; loading: boolean } {
  const { loans, loading } = useLogIndex();

  const stats = useMemo<UserStats | null>(() => {
    if (loans.length === 0) {
      return { uniqueWallets: 0, lenderWallets: 0, borrowerWallets: 0, bothSides: 0 };
    }
    const lenders = new Set<string>();
    const borrowers = new Set<string>();
    for (const row of loans) {
      if (row.lender && row.lender !== ZERO_ADDRESS) lenders.add(row.lender);
      if (row.borrower && row.borrower !== ZERO_ADDRESS) borrowers.add(row.borrower);
    }
    const union = new Set<string>([...lenders, ...borrowers]);
    let bothSides = 0;
    for (const addr of lenders) if (borrowers.has(addr)) bothSides += 1;
    return {
      uniqueWallets: union.size,
      lenderWallets: lenders.size,
      borrowerWallets: borrowers.size,
      bothSides,
    };
  }, [loans]);

  return { stats, loading };
}
