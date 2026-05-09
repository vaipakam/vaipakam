import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const ZERO = '0x0000000000000000000000000000000000000000';
const TOKEN = '0xDeaDBeefdeAdbEEfDeADBeEfDeaDbEEfDEadbeEF';
const MINTER = '0x1111111111111111111111111111111111111111';

const diamondState: {
  getVPFIToken: () => Promise<string>;
  getVPFITotalSupply: () => Promise<bigint>;
  getVPFICap: () => Promise<bigint>;
  getVPFICapHeadroom: () => Promise<bigint>;
  getVPFIMinter: () => Promise<string>;
  getVPFIBalanceOf: (a: string) => Promise<bigint>;
} = {
  getVPFIToken: vi.fn(),
  getVPFITotalSupply: vi.fn(),
  getVPFICap: vi.fn(),
  getVPFICapHeadroom: vi.fn(),
  getVPFIMinter: vi.fn(),
  getVPFIBalanceOf: vi.fn(),
};

const chainState: { chainId: number; diamondAddress: string } = {
  chainId: 11155111,
  diamondAddress: '0x77A16D1807F43A12C1DBde0b06064058cb6FC4BD',
};

vi.mock('../../src/contracts/useDiamond', () => ({
  useDiamondRead: () => diamondState,
  useReadChain: () => chainState,
}));

vi.mock('../../src/lib/journeyLog', () => ({
  beginStep: () => ({ success: vi.fn(), failure: vi.fn() }),
}));

import { useVPFIToken, __clearVPFITokenCache } from '../../src/hooks/useVPFIToken';

const ONE = 10n ** 18n;

beforeEach(() => {
  __clearVPFITokenCache();
  chainState.chainId = 11155111;
  chainState.diamondAddress = '0x77A16D1807F43A12C1DBde0b06064058cb6FC4BD';
});

describe('useVPFIToken', () => {
  it('reports registered=false when the token is the zero address', async () => {
    diamondState.getVPFIToken = vi.fn().mockResolvedValue(ZERO);
    diamondState.getVPFITotalSupply = vi.fn().mockResolvedValue(0n);
    diamondState.getVPFICap = vi.fn().mockResolvedValue(230_000_000n * ONE);
    diamondState.getVPFICapHeadroom = vi.fn().mockResolvedValue(230_000_000n * ONE);
    diamondState.getVPFIMinter = vi.fn().mockResolvedValue(ZERO);
    const { result } = renderHook(() => useVPFIToken());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.snapshot).toMatchObject({
      token: ZERO,
      registered: false,
      totalSupply: 0,
      cap: 230_000_000,
      capHeadroom: 230_000_000,
      circulatingShare: 0,
      minter: ZERO,
    });
  });

  it('computes circulating share and normalizes 1e18 raw values', async () => {
    diamondState.getVPFIToken = vi.fn().mockResolvedValue(TOKEN);
    diamondState.getVPFITotalSupply = vi.fn().mockResolvedValue(46_000_000n * ONE);
    diamondState.getVPFICap = vi.fn().mockResolvedValue(230_000_000n * ONE);
    diamondState.getVPFICapHeadroom = vi.fn().mockResolvedValue(184_000_000n * ONE);
    diamondState.getVPFIMinter = vi.fn().mockResolvedValue(MINTER);
    const { result } = renderHook(() => useVPFIToken());
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    const s = result.current.snapshot!;
    expect(s.registered).toBe(true);
    expect(s.totalSupply).toBeCloseTo(46_000_000, 0);
    expect(s.cap).toBeCloseTo(230_000_000, 0);
    expect(s.capHeadroom).toBeCloseTo(184_000_000, 0);
    expect(s.circulatingShare).toBeCloseTo(0.2, 5);
    expect(s.minter).toBe(MINTER);
  });

  it('returns circulatingShare=0 when cap is zero (divide-by-zero guard)', async () => {
    diamondState.getVPFIToken = vi.fn().mockResolvedValue(TOKEN);
    diamondState.getVPFITotalSupply = vi.fn().mockResolvedValue(0n);
    diamondState.getVPFICap = vi.fn().mockResolvedValue(0n);
    diamondState.getVPFICapHeadroom = vi.fn().mockResolvedValue(0n);
    diamondState.getVPFIMinter = vi.fn().mockResolvedValue(MINTER);
    const { result } = renderHook(() => useVPFIToken());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.snapshot!.circulatingShare).toBe(0);
  });

  it('surfaces a read failure without throwing', async () => {
    diamondState.getVPFIToken = vi.fn().mockRejectedValue(new Error('vpfi facet missing'));
    diamondState.getVPFITotalSupply = vi.fn().mockResolvedValue(0n);
    diamondState.getVPFICap = vi.fn().mockResolvedValue(0n);
    diamondState.getVPFICapHeadroom = vi.fn().mockResolvedValue(0n);
    diamondState.getVPFIMinter = vi.fn().mockResolvedValue(ZERO);
    const { result } = renderHook(() => useVPFIToken());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error?.message).toMatch(/vpfi facet missing/);
    expect(result.current.snapshot).toBeNull();
  });

  it('caches per-chain and re-reads on chain change', async () => {
    const tokenFn = vi.fn().mockResolvedValue(TOKEN);
    diamondState.getVPFIToken = tokenFn;
    diamondState.getVPFITotalSupply = vi.fn().mockResolvedValue(ONE);
    diamondState.getVPFICap = vi.fn().mockResolvedValue(ONE * 2n);
    diamondState.getVPFICapHeadroom = vi.fn().mockResolvedValue(ONE);
    diamondState.getVPFIMinter = vi.fn().mockResolvedValue(MINTER);

    const first = renderHook(() => useVPFIToken());
    await waitFor(() => expect(first.result.current.snapshot).not.toBeNull());
    expect(tokenFn).toHaveBeenCalledTimes(1);

    // Second mount, same chain: served from cache.
    const second = renderHook(() => useVPFIToken());
    await waitFor(() => expect(second.result.current.snapshot).not.toBeNull());
    expect(tokenFn).toHaveBeenCalledTimes(1);

    // Third mount on a different chain: cache key differs → refetch.
    chainState.chainId = 84532;
    chainState.diamondAddress = '0x2222222222222222222222222222222222222222';
    const third = renderHook(() => useVPFIToken());
    await waitFor(() => expect(third.result.current.snapshot).not.toBeNull());
    expect(tokenFn).toHaveBeenCalledTimes(2);
  });

  it('reload() invalidates cache and re-reads', async () => {
    const supplyFn = vi
      .fn()
      .mockResolvedValueOnce(ONE)
      .mockResolvedValueOnce(ONE * 3n);
    diamondState.getVPFIToken = vi.fn().mockResolvedValue(TOKEN);
    diamondState.getVPFITotalSupply = supplyFn;
    diamondState.getVPFICap = vi.fn().mockResolvedValue(ONE * 10n);
    diamondState.getVPFICapHeadroom = vi.fn().mockResolvedValue(ONE * 9n);
    diamondState.getVPFIMinter = vi.fn().mockResolvedValue(MINTER);

    const { result } = renderHook(() => useVPFIToken());
    await waitFor(() => expect(result.current.snapshot?.totalSupply).toBe(1));
    await act(async () => {
      await result.current.reload();
    });
    await waitFor(() => expect(result.current.snapshot?.totalSupply).toBe(3));
    expect(supplyFn).toHaveBeenCalledTimes(2);
  });

  it('getBalanceOf reads an arbitrary account and normalizes', async () => {
    diamondState.getVPFIToken = vi.fn().mockResolvedValue(TOKEN);
    diamondState.getVPFITotalSupply = vi.fn().mockResolvedValue(0n);
    diamondState.getVPFICap = vi.fn().mockResolvedValue(ONE);
    diamondState.getVPFICapHeadroom = vi.fn().mockResolvedValue(ONE);
    diamondState.getVPFIMinter = vi.fn().mockResolvedValue(MINTER);
    diamondState.getVPFIBalanceOf = vi.fn().mockResolvedValue(42n * ONE);

    const { result } = renderHook(() => useVPFIToken());
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    const balance = await result.current.getBalanceOf('0xABC');
    expect(balance).toBe(42);
    expect(diamondState.getVPFIBalanceOf).toHaveBeenCalledWith('0xABC');
  });
});
