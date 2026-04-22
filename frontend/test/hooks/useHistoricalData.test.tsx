import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const statsMock: any = {
  stats: null,
  loading: false,
  error: null,
};
vi.mock('../../src/hooks/useProtocolStats', () => ({
  useProtocolStats: () => statsMock,
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

  it('buckets loans by day and computes rolling TVL', () => {
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
    expect(result.current.series).not.toBeNull();
    expect(result.current.series!.dailyVolume.length).toBeGreaterThan(0);
    expect(result.current.series!.activeVsCompleted.active).toBe(2);
    expect(result.current.series!.activeVsCompleted.completed).toBe(2);
    expect(result.current.series!.activeVsCompleted.defaulted).toBe(1);
    const tvl = result.current.series!.tvl;
    for (let i = 1; i < tvl.length; i++) {
      expect(tvl[i].value).toBeGreaterThanOrEqual(tvl[i - 1].value);
    }
  });

  it('filters out loans older than the requested range', () => {
    const today = Math.floor(Date.now() / 1000);
    statsMock.stats = mkStats({
      loans: [
        mkLoan({ id: 1n, startTime: BigInt(today - 86400 * 3), status: 0n }),
        mkLoan({ id: 2n, startTime: BigInt(today - 86400 * 10), status: 0n }),
      ],
    });
    const { result } = renderHook(() => useHistoricalData('7d'));
    expect(result.current.series!.dailyVolume.length).toBe(1);
  });
});
