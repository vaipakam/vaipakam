import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { AssetType, LoanStatus } from '../../src/types/loan';

const USDC = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const WETH = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const NFT = '0xccccccccccccccccccccccccccccccccccccccccc';

// ── mocks ──────────────────────────────────────────────────────────────────

const statsMock: any = {
  stats: null as any,
  loading: false,
  error: null as Error | null,
};
vi.mock('../../src/hooks/useProtocolStats', () => ({
  useProtocolStats: () => statsMock,
}));

const diamondMock: any = { runner: { provider: {} } };
vi.mock('../../src/contracts/useDiamond', () => ({
  useDiamondRead: () => diamondMock,
  useReadChain: () => ({ chainId: 11155111, diamondAddress: '0xDiamond', deployBlock: 1 }),
}));

const batchState: {
  priceFor?: (asset: string) => [bigint, number] | null;
  throws?: boolean;
} = {};
vi.mock('../../src/lib/multicall', () => ({
  batchCalls: async (
    _p: unknown,
    _i: unknown,
    fragment: string,
    calls: Array<{ callData: string }>,
  ) => {
    if (batchState.throws) throw new Error('multicall blew up');
    if (fragment !== 'getAssetPrice') return calls.map(() => null);
    return calls.map((c) => {
      const asset = '0x' + c.callData.slice(-40).toLowerCase();
      return batchState.priceFor ? batchState.priceFor(asset) ?? null : null;
    });
  },
}));

vi.mock('../../src/lib/tokenMeta', () => ({
  fetchTokenMeta: async (addr: string) => {
    if (addr === USDC) return { address: addr, symbol: 'USDC', decimals: 6 };
    if (addr === WETH) return { address: addr, symbol: 'WETH', decimals: 18 };
    throw new Error('no meta');
  },
}));

vi.mock('../../src/lib/journeyLog', () => ({
  beginStep: () => ({ success: () => {}, failure: () => {} }),
}));

vi.mock('ethers', () => {
  class InterfaceMock {
    encodeFunctionData(_fn: string, args: any[]) {
      const a = args[0];
      if (typeof a === 'string') return '0x' + a.slice(2).padStart(64, '0');
      return '0x' + (a as bigint).toString(16).padStart(64, '0');
    }
    decodeFunctionResult() { return []; }
  }
  return { Interface: InterfaceMock };
});

import { useTVL, __clearTVLCache } from '../../src/hooks/useTVL';

function mkLoan(over: any = {}) {
  return {
    id: over.id ?? 1n,
    offerId: 1n,
    lender: '0xL',
    borrower: '0xB',
    lenderTokenId: 1n,
    borrowerTokenId: 2n,
    principal: over.principal ?? 100n * 10n ** 6n, // 100 USDC
    principalAsset: over.principalAsset ?? USDC,
    interestRateBps: 500n,
    durationDays: 30n,
    startTime: 1_700_000_000n,
    status: over.status ?? BigInt(LoanStatus.Active),
    collateralAsset: over.collateralAsset ?? WETH,
    collateralAmount: over.collateralAmount ?? 1n * 10n ** 18n, // 1 WETH
    collateralAssetType: over.collateralAssetType ?? 0n,
    assetType: over.assetType ?? BigInt(AssetType.ERC20),
    principalLiquidity: 0n,
    collateralLiquidity: 0n,
  };
}

function mkStats(loans: any[] = []) {
  return {
    totalLoans: loans.length,
    activeLoans: loans.length,
    completedLoans: 0,
    defaultedLoans: 0,
    totalOffers: 0,
    activeOffers: 0,
    totalVolumeByAsset: {},
    totalInterestBps: 0n,
    averageAprBps: 0,
    nftRentalsActive: 0,
    erc20ActiveLoans: 0,
    assetBreakdown: [],
    collateralBreakdown: [],
    totalVolumeLentUsd: 0,
    totalInterestEarnedUsd: 0,
    activeLoansValueUsd: 0,
    assetInfo: {},
    loans,
    liquidationRate: 0,
    blockNumber: 1,
    fetchedAt: Date.now(),
  };
}

beforeEach(() => {
  __clearTVLCache();
  statsMock.stats = null;
  statsMock.loading = false;
  statsMock.error = null;
  batchState.priceFor = undefined;
  batchState.throws = false;
});

describe('useTVL', () => {
  it('stays loading while upstream stats are still loading', () => {
    statsMock.loading = true;
    const { result } = renderHook(() => useTVL());
    expect(result.current.loading).toBe(true);
    expect(result.current.snapshot).toBeNull();
  });

  it('forwards the upstream stats error', async () => {
    statsMock.stats = mkStats([]);
    statsMock.error = new Error('stats down');
    const { result } = renderHook(() => useTVL());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error?.message).toMatch(/stats down/);
  });

  it('emits a zero TVL when there are no active loans', async () => {
    statsMock.stats = mkStats([]);
    const { result } = renderHook(() => useTVL());
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    expect(result.current.snapshot!.totalUsd).toBe(0);
    expect(result.current.snapshot!.byAsset).toEqual([]);
  });

  it('skips inactive loans (Repaid / Defaulted / Settled)', async () => {
    statsMock.stats = mkStats([
      mkLoan({ id: 1n, status: BigInt(LoanStatus.Repaid) }),
      mkLoan({ id: 2n, status: BigInt(LoanStatus.Defaulted) }),
      mkLoan({ id: 3n, status: BigInt(LoanStatus.Settled) }),
    ]);
    batchState.priceFor = () => [10n ** 8n, 8];
    const { result } = renderHook(() => useTVL());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.snapshot!.totalUsd).toBe(0);
  });

  it('prices active loan principal + ERC-20 collateral using oracle feeds', async () => {
    statsMock.stats = mkStats([
      mkLoan({
        id: 1n,
        principalAsset: USDC, // 100 USDC @ $1 = $100
        principal: 100n * 10n ** 6n,
        collateralAsset: WETH, // 1 WETH @ $3000
        collateralAmount: 1n * 10n ** 18n,
        status: BigInt(LoanStatus.Active),
      }),
    ]);
    batchState.priceFor = (asset) => {
      if (asset.toLowerCase() === USDC) return [10n ** 8n, 8];
      if (asset.toLowerCase() === WETH) return [3000n * 10n ** 8n, 8];
      return null;
    };
    const { result } = renderHook(() => useTVL());
    await waitFor(() => expect(result.current.snapshot?.totalUsd).toBeGreaterThan(0));
    const s = result.current.snapshot!;
    expect(s.principalUsd).toBeCloseTo(100, 1);
    expect(s.erc20CollateralUsd).toBeCloseTo(3000, 1);
    expect(s.totalUsd).toBeCloseTo(3100, 1);
    expect(s.nftCollateralCount).toBe(0);

    const usdcRow = s.byAsset.find((a) => a.symbol === 'USDC')!;
    const wethRow = s.byAsset.find((a) => a.symbol === 'WETH')!;
    expect(usdcRow.liquid).toBe(true);
    expect(wethRow.liquid).toBe(true);
    expect(usdcRow.usd).toBeCloseTo(100, 1);
    expect(wethRow.usd).toBeCloseTo(3000, 1);
  });

  it('treats unpriced assets as $0 while still listing them in byAsset', async () => {
    statsMock.stats = mkStats([
      mkLoan({
        id: 1n,
        principalAsset: USDC,
        collateralAsset: WETH,
        status: BigInt(LoanStatus.Active),
      }),
    ]);
    // Only USDC has a feed; WETH reverts.
    batchState.priceFor = (asset) =>
      asset.toLowerCase() === USDC ? [10n ** 8n, 8] : null;
    const { result } = renderHook(() => useTVL());
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    const s = result.current.snapshot!;
    const wethRow = s.byAsset.find((a) => a.symbol === 'WETH')!;
    expect(wethRow.usd).toBe(0);
    expect(wethRow.liquid).toBe(false);
    expect(s.erc20CollateralUsd).toBe(0);
    expect(s.totalUsd).toBeCloseTo(100, 1);
  });

  it('counts NFT collateral but contributes zero USD', async () => {
    statsMock.stats = mkStats([
      mkLoan({
        id: 1n,
        principalAsset: USDC,
        collateralAsset: NFT,
        collateralAssetType: BigInt(AssetType.ERC721),
        status: BigInt(LoanStatus.Active),
      }),
    ]);
    batchState.priceFor = (asset) =>
      asset.toLowerCase() === USDC ? [10n ** 8n, 8] : null;
    const { result } = renderHook(() => useTVL());
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    const s = result.current.snapshot!;
    expect(s.nftCollateralCount).toBe(1);
    expect(s.erc20CollateralUsd).toBe(0);
    expect(s.principalUsd).toBeCloseTo(100, 1);
  });

  it('surfaces an error when the price multicall throws', async () => {
    statsMock.stats = mkStats([
      mkLoan({ id: 1n, status: BigInt(LoanStatus.Active) }),
    ]);
    batchState.throws = true;
    const { result } = renderHook(() => useTVL());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error?.message).toMatch(/multicall blew up/);
  });

  it('caches across remounts until __clearTVLCache is called', async () => {
    statsMock.stats = mkStats([
      mkLoan({ id: 1n, status: BigInt(LoanStatus.Active) }),
    ]);
    let priceCalls = 0;
    batchState.priceFor = () => {
      priceCalls += 1;
      return [10n ** 8n, 8];
    };
    const first = renderHook(() => useTVL());
    await waitFor(() => expect(first.result.current.snapshot).not.toBeNull());
    const afterFirst = priceCalls;
    const second = renderHook(() => useTVL());
    await waitFor(() => expect(second.result.current.snapshot).not.toBeNull());
    // Second mount served from cache.
    expect(priceCalls).toBe(afterFirst);
    __clearTVLCache();
    const third = renderHook(() => useTVL());
    await waitFor(() => expect(third.result.current.snapshot).not.toBeNull());
    expect(priceCalls).toBeGreaterThan(afterFirst);
  });
});
