import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const DIAMOND = '0x77A16D1807F43A12C1DBde0b06064058cb6FC4BD';
const ASSET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const COLLATERAL = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const CREATOR = '0x1111111111111111111111111111111111111111';

const logIndexMock: any = {
  offerIds: [] as bigint[],
  loading: false,
  error: null as Error | null,
};
vi.mock('../../src/hooks/useLogIndex', () => ({
  useLogIndex: () => logIndexMock,
}));

const diamondMock: any = { runner: { provider: {} } };
vi.mock('../../src/contracts/useDiamond', () => ({
  useDiamondRead: () => diamondMock,
}));

vi.mock('../../src/contracts/config', () => ({
  DEFAULT_CHAIN: {
    chainId: 11155111,
    diamondAddress: '0x77A16D1807F43A12C1DBde0b06064058cb6FC4BD',
    deployBlock: 1,
  },
}));

vi.mock('../../src/contracts/abis', () => ({ DIAMOND_ABI: [] }));

vi.mock('../../src/lib/journeyLog', () => ({
  beginStep: () => ({ success: vi.fn(), failure: vi.fn() }),
}));

const batchState: {
  offerFor?: (id: bigint) => any | null;
  throws?: boolean;
} = {};

vi.mock('../../src/lib/multicall', () => ({
  batchCalls: async (
    _p: unknown,
    _i: unknown,
    fragment: string,
    calls: Array<{ callData: string }>,
  ) => {
    if (batchState.throws) throw new Error('multicall down');
    if (fragment !== 'getOffer') return calls.map(() => null);
    // The iface mock packs the offerId as a hex suffix of callData.
    return calls.map((c) => {
      const id = BigInt('0x' + c.callData.slice(-64));
      return batchState.offerFor ? batchState.offerFor(id) ?? null : null;
    });
  },
}));

vi.mock('ethers', () => {
  class InterfaceMock {
    encodeFunctionData(_fn: string, args: any[]) {
      const id = args[0] as bigint;
      return '0x' + id.toString(16).padStart(64, '0');
    }
    decodeFunctionResult() {
      return [];
    }
  }
  return { Interface: InterfaceMock };
});

import {
  useRecentOffers,
  __clearRecentOffersCache,
} from '../../src/hooks/useRecentOffers';

function mkOffer(id: bigint, over: any = {}) {
  return {
    id,
    creator: CREATOR,
    offerType: 0n,
    lendingAsset: ASSET,
    amount: 1000n * 10n ** 6n,
    interestRateBps: 500n,
    collateralAsset: COLLATERAL,
    collateralAmount: 10n ** 18n,
    durationDays: 30n,
    principalLiquidity: 2n,
    collateralLiquidity: 1n,
    accepted: false,
    assetType: 0n,
    tokenId: 0n,
    ...over,
  };
}

beforeEach(() => {
  __clearRecentOffersCache();
  logIndexMock.offerIds = [];
  logIndexMock.loading = false;
  logIndexMock.error = null;
  batchState.offerFor = undefined;
  batchState.throws = false;
});

describe('useRecentOffers', () => {
  it('stays loading while the event index is still warming', () => {
    logIndexMock.loading = true;
    const { result } = renderHook(() => useRecentOffers(10));
    expect(result.current.loading).toBe(true);
    expect(result.current.offers).toEqual([]);
  });

  it('returns an empty list when the index reports no offers', async () => {
    logIndexMock.offerIds = [];
    const { result } = renderHook(() => useRecentOffers(10));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.offers).toEqual([]);
  });

  it('sorts offer ids descending and caps at the requested limit', async () => {
    logIndexMock.offerIds = [1n, 2n, 3n, 4n, 5n];
    batchState.offerFor = (id) => mkOffer(id);
    const { result } = renderHook(() => useRecentOffers(3));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.offers.map((o) => o.id)).toEqual([5n, 4n, 3n]);
  });

  it('normalizes bigint offerType/assetType/liquidity fields into JS numbers', async () => {
    logIndexMock.offerIds = [7n];
    batchState.offerFor = (id) =>
      mkOffer(id, {
        offerType: 1n,
        assetType: 2n,
        principalLiquidity: 3n,
        collateralLiquidity: 4n,
      });
    const { result } = renderHook(() => useRecentOffers(10));
    await waitFor(() => expect(result.current.offers.length).toBe(1));
    const o = result.current.offers[0];
    expect(o.offerType).toBe(1);
    expect(o.assetType).toBe(2);
    expect(o.principalLiquidity).toBe(3);
    expect(o.collateralLiquidity).toBe(4);
    expect(typeof o.id).toBe('bigint');
  });

  it('skips null (reverted) slots in the multicall response', async () => {
    logIndexMock.offerIds = [1n, 2n, 3n];
    batchState.offerFor = (id) => (id === 2n ? null : mkOffer(id));
    const { result } = renderHook(() => useRecentOffers(10));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.offers.map((o) => o.id)).toEqual([3n, 1n]);
  });

  it('surfaces a multicall failure as hook error', async () => {
    logIndexMock.offerIds = [1n];
    batchState.throws = true;
    const { result } = renderHook(() => useRecentOffers(10));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error?.message).toMatch(/multicall down/);
  });

  it('forwards a log-index error into the hook error', async () => {
    logIndexMock.offerIds = [];
    logIndexMock.error = new Error('log index broken');
    const { result } = renderHook(() => useRecentOffers(10));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error?.message).toMatch(/log index broken/);
  });

  it('serves a second mount from cache without a second multicall', async () => {
    logIndexMock.offerIds = [1n, 2n];
    let fetches = 0;
    batchState.offerFor = (id) => {
      fetches += 1;
      return mkOffer(id);
    };
    const first = renderHook(() => useRecentOffers(10));
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    const afterFirst = fetches;
    const second = renderHook(() => useRecentOffers(10));
    await waitFor(() => expect(second.result.current.offers.length).toBe(2));
    expect(fetches).toBe(afterFirst);
  });

  it('__clearRecentOffersCache forces a cold fetch', async () => {
    logIndexMock.offerIds = [1n];
    let fetches = 0;
    batchState.offerFor = (id) => {
      fetches += 1;
      return mkOffer(id);
    };
    const first = renderHook(() => useRecentOffers(10));
    await waitFor(() => expect(first.result.current.offers.length).toBe(1));
    expect(fetches).toBe(1);
    __clearRecentOffersCache();
    const second = renderHook(() => useRecentOffers(10));
    await waitFor(() => expect(second.result.current.offers.length).toBe(1));
    expect(fetches).toBe(2);
  });
});
