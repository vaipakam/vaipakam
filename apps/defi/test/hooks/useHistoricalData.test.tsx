import { describe, it, expect, vi } from 'vitest';
vi.mock('../../src/hooks/useLiveWatermark', () => ({
  // #1076: watermark needs WatermarkProvider (excluded from the test
  // harness for its WS/timer side-effects); stub it for hook tests.
  useLiveWatermark: () => ({ version: 0, snapshot: null, status: 'unreachable' }),
}));

import { renderHook, waitFor } from '@testing-library/react';

const statsMock: any = {
  stats: null,
  loading: false,
  error: null,
};
vi.mock('../../src/hooks/useProtocolStats', () => ({
  useProtocolStats: () => statsMock,
}));

// #1076: the hook is indexer-first with a chain-side fallback. These
// fixtures (`stats.loans` + `stats.assetInfo`) are the FALLBACK path's
// data shape — the JS bucket walk over the multicall'd loan list — so we
// force that path by returning null from the indexer timeseries fetch
// (worker-unreachable). The indexer-first branch consumes a wholly
// different shape (`ts.buckets` + on-chain getAssetPrice + fetchTokenMeta)
// and is exercised elsewhere.
vi.mock('../../src/lib/indexerClient', () => ({
  fetchLoanTimeseries: () => Promise.resolve(null),
}));

// `activeVsCompleted` prefers loanStats (indexer-fresh) when present. Null
// here so the counts derive from the `stats.loans` status walk the fixtures
// set up (2 active / 2 completed / 1 defaulted).
vi.mock('../../src/hooks/useLoanStats', () => ({
  useLoanStats: () => ({ stats: null }),
}));

// #1076: source calls useReadChain + useDiamondPublicClient directly.
vi.mock('../../src/contracts/useDiamond', () => ({
  useReadChain: () => ({ chainId: 11155111, diamondAddress: '0x00000000000000000000000000000000000000D1', deployBlock: 1 }),
  useDiamondPublicClient: () => ({}),
}));

import { useHistoricalData } from '../../src/hooks/useHistoricalData';

const ASSET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function mkLoan(over: any = {}) {
  return {
    id: 1n,
    startTime: BigInt(Math.floor(Date.now() / 1000) - 3600),
    principal: 1_000_000_000_000_000_000n,
    principalAsset: ASSET,
    assetType: 0n,
    interestRateBps: 500n,
    status: 0n,
    ...over,
  };
}

// Hook expects stats.assetInfo keyed by lowercase address with
// oracle price + decimals metadata so per-asset USD math works
// regardless of token decimals. A dollar-priced 18-decimal token is
// the simplest keyable setup for these tests.
const ASSET_INFO = {
  [ASSET.toLowerCase()]: {
    symbol: 'MOCK',
    price: 10n ** 8n,
    priceDecimals: 8,
    tokenDecimals: 18,
  },
};

function mkStats(over: any = {}) {
  return {
    loans: [],
    assetInfo: ASSET_INFO,
    ...over,
  };
}

describe('useHistoricalData', () => {
  it('returns null series when stats are missing', () => {
    statsMock.stats = null;
    const { result } = renderHook(() => useHistoricalData('30d'));
    expect(result.current.series).toBeNull();
  });

  it('buckets loans by day and computes rolling TVL', async () => {
    const today = Math.floor(Date.now() / 1000);
    statsMock.stats = mkStats({
      loans: [
        mkLoan({ id: 1n, startTime: BigInt(today - 3600), status: 0n }),
        mkLoan({ id: 2n, startTime: BigInt(today - 3600 * 2), status: 0n }),
        mkLoan({ id: 3n, startTime: BigInt(today - 86400 * 2), status: 1n }),
        mkLoan({ id: 4n, startTime: BigInt(today - 86400 * 60), status: 2n }),
      ],
    });
    const { result } = renderHook(() => useHistoricalData('30d'));
    // Series is now set asynchronously (the hook awaits the indexer fetch —
    // mocked to null — before the chain-side bucket walk runs).
    await waitFor(() => expect(result.current.series).not.toBeNull());
    expect(result.current.series!.dailyVolume.length).toBeGreaterThan(0);
    expect(result.current.series!.activeVsCompleted.active).toBe(2);
    expect(result.current.series!.activeVsCompleted.completed).toBe(2);
    expect(result.current.series!.activeVsCompleted.defaulted).toBe(1);
    const tvl = result.current.series!.tvl;
    for (let i = 1; i < tvl.length; i++) {
      expect(tvl[i].value).toBeGreaterThanOrEqual(tvl[i - 1].value);
    }
  });

  it('filters out loans older than the requested range', async () => {
    const today = Math.floor(Date.now() / 1000);
    statsMock.stats = mkStats({
      loans: [
        mkLoan({ id: 1n, startTime: BigInt(today - 86400 * 3), status: 0n }),
        mkLoan({ id: 2n, startTime: BigInt(today - 86400 * 10), status: 0n }),
      ],
    });
    const { result } = renderHook(() => useHistoricalData('7d'));
    await waitFor(() => expect(result.current.series).not.toBeNull());
    expect(result.current.series!.dailyVolume.length).toBe(1);
  });
});
