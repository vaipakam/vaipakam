import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { LoanStatus } from '../../src/types/loan';

const LENDER = '0x1111111111111111111111111111111111111111';
const BORROWER = '0x2222222222222222222222222222222222222222';
const STRANGER = '0x3333333333333333333333333333333333333333';
const USDC = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const WETH = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const logIndexMock: {
  loans: Array<{ loanId: bigint; lender: string; borrower: string }>;
  getOwner: (id: bigint) => string | null;
  loading: boolean;
  reload: ReturnType<typeof vi.fn>;
} = {
  loans: [],
  getOwner: () => null,
  loading: false,
  reload: vi.fn(async () => {}),
};
vi.mock('../../src/hooks/useLogIndex', () => ({
  useLogIndex: () => logIndexMock,
}));

const diamondState: {
  getLoanDetails: (id: bigint) => Promise<any>;
  ownerOf: (id: bigint) => Promise<string>;
} = {
  getLoanDetails: vi.fn(),
  ownerOf: vi.fn(),
};
vi.mock('../../src/contracts/useDiamond', () => ({
  useDiamondRead: () => diamondState,
}));

vi.mock('../../src/lib/journeyLog', () => ({
  beginStep: () => ({ success: vi.fn(), failure: vi.fn() }),
}));

import { useUserLoans } from '../../src/hooks/useUserLoans';

function mkLoanDetails(over: any = {}) {
  return {
    id: over.id ?? 1n,
    principal: 100n * 10n ** 6n,
    principalAsset: USDC,
    interestRateBps: 500n,
    durationDays: 30n,
    startTime: 1_700_000_000n,
    status: over.status ?? BigInt(LoanStatus.Active),
    lenderTokenId: over.lenderTokenId ?? 10n,
    borrowerTokenId: over.borrowerTokenId ?? 20n,
    collateralAsset: WETH,
    collateralAmount: 10n ** 18n,
    ...over,
  };
}

beforeEach(() => {
  logIndexMock.loans = [];
  logIndexMock.getOwner = () => null;
  logIndexMock.loading = false;
  logIndexMock.reload = vi.fn(async () => {});
  diamondState.getLoanDetails = vi.fn();
  diamondState.ownerOf = vi.fn();
});

describe('useUserLoans', () => {
  it('returns an empty list when no address is connected', async () => {
    const { result } = renderHook(() => useUserLoans(null));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.loans).toEqual([]);
  });

  it('returns an empty list when there are no indexed loans', async () => {
    const { result } = renderHook(() => useUserLoans(LENDER));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.loans).toEqual([]);
  });

  it('tags loans where the wallet owns the lender NFT with role="lender"', async () => {
    logIndexMock.loans = [{ loanId: 1n, lender: LENDER, borrower: BORROWER }];
    logIndexMock.getOwner = (id) => (id === 10n ? LENDER.toLowerCase() : BORROWER.toLowerCase());
    diamondState.getLoanDetails = vi.fn().mockResolvedValue(mkLoanDetails({ id: 1n }));
    const { result } = renderHook(() => useUserLoans(LENDER));
    await waitFor(() => expect(result.current.loans.length).toBe(1));
    expect(result.current.loans[0]).toMatchObject({ id: 1n, role: 'lender' });
  });

  it('tags loans where the wallet owns the borrower NFT with role="borrower"', async () => {
    logIndexMock.loans = [{ loanId: 1n, lender: LENDER, borrower: BORROWER }];
    logIndexMock.getOwner = (id) => (id === 10n ? LENDER.toLowerCase() : BORROWER.toLowerCase());
    diamondState.getLoanDetails = vi.fn().mockResolvedValue(mkLoanDetails({ id: 1n }));
    const { result } = renderHook(() => useUserLoans(BORROWER));
    await waitFor(() => expect(result.current.loans.length).toBe(1));
    expect(result.current.loans[0].role).toBe('borrower');
  });

  it('skips loans where the wallet owns neither NFT', async () => {
    logIndexMock.loans = [{ loanId: 1n, lender: LENDER, borrower: BORROWER }];
    logIndexMock.getOwner = (id) => (id === 10n ? LENDER.toLowerCase() : BORROWER.toLowerCase());
    diamondState.getLoanDetails = vi.fn().mockResolvedValue(mkLoanDetails({ id: 1n }));
    const { result } = renderHook(() => useUserLoans(STRANGER));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.loans).toEqual([]);
  });

  it('falls back to ownerOf() when the index has no owner cached', async () => {
    logIndexMock.loans = [{ loanId: 1n, lender: LENDER, borrower: BORROWER }];
    logIndexMock.getOwner = () => null; // no cached entries
    diamondState.getLoanDetails = vi.fn().mockResolvedValue(mkLoanDetails({ id: 1n }));
    diamondState.ownerOf = vi
      .fn()
      .mockImplementation(async (id: bigint) =>
        id === 10n ? LENDER : BORROWER,
      );
    const { result } = renderHook(() => useUserLoans(LENDER));
    await waitFor(() => expect(result.current.loans.length).toBe(1));
    expect(diamondState.ownerOf).toHaveBeenCalledTimes(2);
  });

  it('survives a single bad loan — later loans still surface', async () => {
    logIndexMock.loans = [
      { loanId: 1n, lender: LENDER, borrower: BORROWER },
      { loanId: 2n, lender: LENDER, borrower: BORROWER },
    ];
    logIndexMock.getOwner = (id) => (id === 10n ? LENDER.toLowerCase() : BORROWER.toLowerCase());
    diamondState.getLoanDetails = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new Error('bad loan');
      })
      .mockImplementationOnce(async () => mkLoanDetails({ id: 2n }));
    const { result } = renderHook(() => useUserLoans(LENDER));
    await waitFor(() => expect(result.current.loans.length).toBe(1));
    expect(result.current.loans[0].id).toBe(2n);
  });

  it('reload() forwards to the log-index reload and re-scans', async () => {
    logIndexMock.loans = [{ loanId: 1n, lender: LENDER, borrower: BORROWER }];
    logIndexMock.getOwner = (id) => (id === 10n ? LENDER.toLowerCase() : BORROWER.toLowerCase());
    const detailsFn = vi
      .fn()
      .mockResolvedValueOnce(mkLoanDetails({ id: 1n }))
      .mockResolvedValueOnce(mkLoanDetails({ id: 1n }));
    diamondState.getLoanDetails = detailsFn;
    const { result } = renderHook(() => useUserLoans(LENDER));
    await waitFor(() => expect(result.current.loans.length).toBe(1));
    await act(async () => {
      await result.current.reload();
    });
    expect(logIndexMock.reload).toHaveBeenCalledTimes(1);
    expect(detailsFn).toHaveBeenCalledTimes(2);
  });
});
