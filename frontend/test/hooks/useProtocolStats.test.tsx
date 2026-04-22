import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { AssetType, LoanStatus } from '../../src/types/loan';

const ASSET_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ASSET_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const NFT_ASSET = '0xccccccccccccccccccccccccccccccccccccccccc';
const DIAMOND = '0x77A16D1807F43A12C1DBde0b06064058cb6FC4BD';

// ── mocks ──────────────────────────────────────────────────────────────────

const logIndexMock: any = {
  loans: [] as Array<{ loanId: bigint; lender: string; borrower: string }>,
  offerIds: [] as bigint[],
  openOfferIds: [] as bigint[],
  loading: false,
  error: null,
  reload: vi.fn(),
};
vi.mock('../../src/hooks/useLogIndex', () => ({ useLogIndex: () => logIndexMock }));

const diamondMock: any = {
  runner: { provider: {
    // Loose stand-in — the real hook reads blockNumber off this.
    getBlockNumber: async () => 999_000,
  } },
};
vi.mock('../../src/contracts/useDiamond', () => ({
  useDiamondRead: () => diamondMock,
  useReadChain: () => ({
    chainId: 11155111,
    diamondAddress: DIAMOND,
    deployBlock: 1,
  }),
}));

// `batchCalls(provider, iface, fragment, calls)` is where all expensive reads
// land. Stubbing at this boundary lets us control what the hook sees for
// `getLoanDetails` vs `getAssetPrice` without needing a real multicall3.
const batchBehavior: {
  loanDetails?: (id: bigint) => any | null;
  priceFor?: (asset: string) => [bigint, number] | null;
  priceThrows?: boolean;
} = {};
vi.mock('../../src/lib/multicall', () => ({
  batchCalls: async (
    _provider: unknown,
    _iface: unknown,
    fragment: string,
    calls: Array<{ target: string; callData: string }>,
  ) => {
    if (fragment === 'getLoanDetails') {
      // The hook encodes loanId in callData[2:] — but we can't easily decode
      // here without the real iface. Instead we match calls 1:1 with the
      // indexed loan list in order (useProtocolStats preserves order).
      return logIndexMock.loans.map((l: any) =>
        batchBehavior.loanDetails ? batchBehavior.loanDetails(l.loanId) : null,
      );
    }
    if (fragment === 'getAssetPrice') {
      if (batchBehavior.priceThrows) throw new Error('price multicall down');
      // We need to know which assets were asked for. Since we control the
      // hook's callers, the price list order matches the ERC-20 assets seen
      // in the loan set. `priceFor` keyed by asset lets each test return a
      // concrete feed or null for "no feed".
      // Emulate by scanning callData for a 20-byte address suffix.
      return calls.map((c) => {
        const asset = '0x' + c.callData.slice(-40).toLowerCase();
        return batchBehavior.priceFor ? batchBehavior.priceFor(asset) ?? null : null;
      });
    }
    return calls.map(() => null);
  },
}));

// Skip metadata RPCs — return stable symbol/decimals per asset.
vi.mock('../../src/lib/tokenMeta', () => ({
  fetchTokenMeta: async (addr: string) => ({
    address: addr,
    symbol: addr === ASSET_A ? 'USDC' : addr === ASSET_B ? 'WETH' : 'X',
    decimals: addr === ASSET_A ? 6 : 18,
  }),
}));

vi.mock('../../src/lib/journeyLog', () => ({
  beginStep: () => ({ success: () => {}, failure: () => {} }),
}));

// Interface encode has a real implementation from ethers — but we mock the
// whole module in the ethersMock used by other tests. Here we only need
// encode to return a string with the asset address suffix we decode above.
vi.mock('ethers', () => {
  class InterfaceMock {
    encodeFunctionData(_fn: string, args: any[]) {
      // Pack the first arg as address or bigint suffix so batchCalls mock
      // can route to the right stub.
      const arg = args[0];
      if (typeof arg === 'string' && arg.startsWith('0x')) {
        return '0x' + arg.slice(2).padStart(64, '0');
      }
      return '0x' + (arg as bigint).toString(16).padStart(64, '0');
    }
    decodeFunctionResult(_fn: string, _data: string) {
      return [];
    }
  }
  return { Interface: InterfaceMock };
});

import { useProtocolStats, __clearProtocolStatsCache } from '../../src/hooks/useProtocolStats';

function mkLoan(over: any = {}) {
  return {
    id: over.id ?? 1n,
    offerId: 1n,
    lender: '0xLENDER',
    borrower: '0xBORROWER',
    lenderTokenId: 1n,
    borrowerTokenId: 2n,
    principal: over.principal ?? 1000n * 10n ** 18n,
    principalAsset: over.principalAsset ?? ASSET_A,
    interestRateBps: over.interestRateBps ?? 500n,
    durationDays: 30n,
    startTime: 1_700_000_000n,
    status: over.status ?? BigInt(LoanStatus.Active),
    collateralAsset: over.collateralAsset ?? ASSET_B,
    collateralAmount: over.collateralAmount ?? 2n * 10n ** 18n,
    collateralAssetType: 0n,
    assetType: over.assetType ?? BigInt(AssetType.ERC20),
    principalLiquidity: 0n,
    collateralLiquidity: 0n,
  };
}

beforeEach(() => {
  __clearProtocolStatsCache();
  logIndexMock.loans = [];
  logIndexMock.offerIds = [];
  logIndexMock.openOfferIds = [];
  logIndexMock.loading = false;
  logIndexMock.error = null;
  batchBehavior.loanDetails = undefined;
  batchBehavior.priceFor = undefined;
  batchBehavior.priceThrows = false;
});

describe('useProtocolStats', () => {
  it('returns an empty-state stats when the log index has no loans or offers', async () => {
    const { result } = renderHook(() => useProtocolStats());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.stats).not.toBeNull();
    expect(result.current.stats!.totalLoans).toBe(0);
    expect(result.current.stats!.activeLoans).toBe(0);
    expect(result.current.stats!.averageAprBps).toBe(0);
    expect(result.current.stats!.assetBreakdown).toEqual([]);
    expect(result.current.stats!.liquidationRate).toBe(0);
  });

  it('aggregates active / completed / defaulted counts and APR', async () => {
    logIndexMock.loans = [
      { loanId: 1n, lender: '0xa', borrower: '0xb' },
      { loanId: 2n, lender: '0xa', borrower: '0xb' },
      { loanId: 3n, lender: '0xa', borrower: '0xb' },
      { loanId: 4n, lender: '0xa', borrower: '0xb' },
    ];
    const byId: Record<string, any> = {
      '1': mkLoan({ id: 1n, status: BigInt(LoanStatus.Active), interestRateBps: 400n }),
      '2': mkLoan({ id: 2n, status: BigInt(LoanStatus.Repaid), interestRateBps: 600n }),
      '3': mkLoan({ id: 3n, status: BigInt(LoanStatus.Defaulted), interestRateBps: 800n }),
      '4': mkLoan({ id: 4n, status: BigInt(LoanStatus.FallbackPending), interestRateBps: 1000n }),
    };
    batchBehavior.loanDetails = (id) => byId[id.toString()] ?? null;
    batchBehavior.priceFor = () => [10n ** 8n, 8]; // $1.00, 8-decimal feed
    const { result } = renderHook(() => useProtocolStats());
    await waitFor(() => expect(result.current.stats?.totalLoans).toBe(4));
    const s = result.current.stats!;
    expect(s.activeLoans).toBe(2); // Active + FallbackPending
    expect(s.defaultedLoans).toBe(1);
    // completedLoans includes Repaid + Defaulted per the hook's accounting.
    expect(s.completedLoans).toBe(2);
    expect(s.averageAprBps).toBeCloseTo(700, 5);
    expect(s.liquidationRate).toBeCloseTo(25, 5);
  });

  it('filters out multicall decode failures (null slots) and counts only decoded loans', async () => {
    logIndexMock.loans = [
      { loanId: 1n, lender: '0xa', borrower: '0xb' },
      { loanId: 2n, lender: '0xa', borrower: '0xb' },
    ];
    batchBehavior.loanDetails = (id) => (id === 1n ? mkLoan({ id: 1n }) : null);
    batchBehavior.priceFor = () => [10n ** 8n, 8];
    const { result } = renderHook(() => useProtocolStats());
    await waitFor(() => expect(result.current.stats?.totalLoans).toBe(1));
  });

  it('computes USD volume and interest earned using oracle prices', async () => {
    logIndexMock.loans = [
      { loanId: 1n, lender: '0xa', borrower: '0xb' },
      { loanId: 2n, lender: '0xa', borrower: '0xb' },
    ];
    batchBehavior.loanDetails = (id) => {
      if (id === 1n)
        return mkLoan({
          id: 1n,
          principalAsset: ASSET_A,
          principal: 100n * 10n ** 6n, // 100 USDC (6-decimal)
          status: BigInt(LoanStatus.Active),
          interestRateBps: 500n,
        });
      if (id === 2n)
        return mkLoan({
          id: 2n,
          principalAsset: ASSET_B,
          principal: 1n * 10n ** 18n, // 1 WETH (18-decimal)
          status: BigInt(LoanStatus.Repaid),
          interestRateBps: 1000n,
        });
      return null;
    };
    batchBehavior.priceFor = (asset) => {
      if (asset.toLowerCase() === ASSET_A) return [10n ** 8n, 8]; // $1
      if (asset.toLowerCase() === ASSET_B) return [3000n * 10n ** 8n, 8]; // $3000
      return null;
    };
    const { result } = renderHook(() => useProtocolStats());
    await waitFor(() => expect(result.current.stats?.totalLoans).toBe(2));
    const s = result.current.stats!;
    // lifetime volume: 100 USDC + 1 WETH ≈ $100 + $3000 = $3100
    expect(s.totalVolumeLentUsd).toBeCloseTo(3100, 1);
    // active-value: only the USDC loan is active
    expect(s.activeLoansValueUsd).toBeCloseTo(100, 1);
    // interest earned: only on the repaid WETH loan (1000bps * $3000 = $300)
    expect(s.totalInterestEarnedUsd).toBeCloseTo(300, 1);
    // breakdown sorted by volumeUsd desc — WETH row first
    expect(s.assetBreakdown[0].volumeUsd).toBeGreaterThan(s.assetBreakdown[1].volumeUsd);
    expect(s.assetBreakdown[0].share).toBeGreaterThan(s.assetBreakdown[1].share);
  });

  it('treats assets with no oracle feed as illiquid (volumeUsd=0, liquid=false)', async () => {
    logIndexMock.loans = [{ loanId: 1n, lender: '0xa', borrower: '0xb' }];
    batchBehavior.loanDetails = () =>
      mkLoan({
        id: 1n,
        principalAsset: ASSET_A,
        principal: 100n * 10n ** 6n,
        status: BigInt(LoanStatus.Active),
      });
    batchBehavior.priceFor = () => null; // no feed
    const { result } = renderHook(() => useProtocolStats());
    await waitFor(() => expect(result.current.stats?.assetBreakdown.length).toBe(1));
    const row = result.current.stats!.assetBreakdown[0];
    expect(row.volumeUsd).toBe(0);
    expect(row.liquid).toBe(false);
    expect(result.current.stats!.totalVolumeLentUsd).toBe(0);
  });

  it('splits NFT rentals from ERC-20 active loans', async () => {
    logIndexMock.loans = [
      { loanId: 1n, lender: '0xa', borrower: '0xb' },
      { loanId: 2n, lender: '0xa', borrower: '0xb' },
    ];
    batchBehavior.loanDetails = (id) =>
      id === 1n
        ? mkLoan({ id: 1n, assetType: BigInt(AssetType.ERC20) })
        : mkLoan({
            id: 2n,
            assetType: BigInt(AssetType.ERC721),
            principalAsset: NFT_ASSET,
          });
    batchBehavior.priceFor = (asset) =>
      asset.toLowerCase() === ASSET_A ? [10n ** 8n, 8] : null;
    const { result } = renderHook(() => useProtocolStats());
    await waitFor(() => expect(result.current.stats?.totalLoans).toBe(2));
    const s = result.current.stats!;
    expect(s.erc20ActiveLoans).toBe(1);
    expect(s.nftRentalsActive).toBe(1);
  });

  it('surfaces error when the price multicall throws', async () => {
    logIndexMock.loans = [{ loanId: 1n, lender: '0xa', borrower: '0xb' }];
    batchBehavior.loanDetails = () => mkLoan({ id: 1n });
    batchBehavior.priceThrows = true;
    const { result } = renderHook(() => useProtocolStats());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error!.message).toMatch(/price multicall down/);
  });

  it('reports the provider block number when available', async () => {
    logIndexMock.loans = [];
    const { result } = renderHook(() => useProtocolStats());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.stats!.blockNumber).toBe(999_000);
  });

  it('caches across remounts until cache is cleared', async () => {
    logIndexMock.loans = [{ loanId: 1n, lender: '0xa', borrower: '0xb' }];
    let callCount = 0;
    batchBehavior.loanDetails = (id) => {
      callCount += 1;
      return mkLoan({ id });
    };
    batchBehavior.priceFor = () => [10n ** 8n, 8];
    const first = renderHook(() => useProtocolStats());
    await waitFor(() => expect(first.result.current.stats?.totalLoans).toBe(1));
    const afterFirst = callCount;
    const second = renderHook(() => useProtocolStats());
    await waitFor(() => expect(second.result.current.stats?.totalLoans).toBe(1));
    // Second mount reads from cache, so no new loanDetails calls.
    expect(callCount).toBe(afterFirst);
  });
});
