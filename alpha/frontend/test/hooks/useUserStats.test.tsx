import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const logIndexMock = {
  loans: [] as Array<{ loanId: bigint; lender: string; borrower: string }>,
  offerIds: [] as bigint[],
  openOfferIds: [] as bigint[],
  lastAcceptedOfferId: null as bigint | null,
  getOwner: (_id: bigint) => null,
  loading: false,
  error: null,
  reload: vi.fn(),
};
vi.mock('../../src/hooks/useLogIndex', () => ({ useLogIndex: () => logIndexMock }));

import { useUserStats } from '../../src/hooks/useUserStats';

describe('useUserStats', () => {
  it('returns zero counts on empty index', () => {
    logIndexMock.loans = [];
    const { result } = renderHook(() => useUserStats());
    expect(result.current.stats).toEqual({
      uniqueWallets: 0,
      lenderWallets: 0,
      borrowerWallets: 0,
      bothSides: 0,
    });
  });

  it('counts unique lenders, borrowers, and overlap', () => {
    logIndexMock.loans = [
      { loanId: 1n, lender: '0xaaa', borrower: '0xbbb' },
      { loanId: 2n, lender: '0xccc', borrower: '0xaaa' }, // 0xaaa appears both sides
      { loanId: 3n, lender: '0xaaa', borrower: '0xddd' }, // dup lender
    ];
    const { result } = renderHook(() => useUserStats());
    expect(result.current.stats).toEqual({
      uniqueWallets: 4,
      lenderWallets: 2,
      borrowerWallets: 3,
      bothSides: 1,
    });
  });

  it('skips zero-address entries', () => {
    logIndexMock.loans = [
      { loanId: 1n, lender: '0x0000000000000000000000000000000000000000', borrower: '0xbbb' },
    ];
    const { result } = renderHook(() => useUserStats());
    expect(result.current.stats?.uniqueWallets).toBe(1);
    expect(result.current.stats?.lenderWallets).toBe(0);
  });
});
