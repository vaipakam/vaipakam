import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const diamondState: {
  getTreasuryMetrics: () => Promise<[bigint, bigint, bigint, bigint]>;
} = {
  getTreasuryMetrics: vi.fn(),
};

vi.mock('../../src/contracts/useDiamond', () => ({
  useDiamondRead: () => diamondState,
}));

vi.mock('../../src/lib/journeyLog', () => ({
  beginStep: () => ({ success: vi.fn(), failure: vi.fn() }),
}));

import {
  useTreasuryMetrics,
  __clearTreasuryMetricsCache,
} from '../../src/hooks/useTreasuryMetrics';

const ONE_USD_18 = 10n ** 18n;

beforeEach(() => {
  __clearTreasuryMetricsCache();
  diamondState.getTreasuryMetrics = vi.fn();
});

describe('useTreasuryMetrics', () => {
  it('normalizes on-chain 1e18 USD figures into JS numbers', async () => {
    diamondState.getTreasuryMetrics = vi
      .fn()
      .mockResolvedValue([
        100n * ONE_USD_18, // treasury balance $100
        5_000n * ONE_USD_18, // lifetime $5000
        25n * ONE_USD_18, // 24h $25
        500n * ONE_USD_18, // 7d $500
      ]);
    const { result } = renderHook(() => useTreasuryMetrics());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.metrics).toMatchObject({
      treasuryBalanceUsd: 100,
      totalFeesCollectedUsd: 5000,
      feesLast24hUsd: 25,
      feesLast7dUsd: 500,
    });
    expect(result.current.error).toBeNull();
  });

  it('surfaces an error when the Diamond call reverts', async () => {
    diamondState.getTreasuryMetrics = vi
      .fn()
      .mockRejectedValue(new Error('facet missing'));
    const { result } = renderHook(() => useTreasuryMetrics());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error?.message).toMatch(/facet missing/);
    expect(result.current.metrics).toBeNull();
  });

  it('serves the second mount from cache without a second RPC call', async () => {
    const call = vi
      .fn()
      .mockResolvedValue([ONE_USD_18, ONE_USD_18, ONE_USD_18, ONE_USD_18]);
    diamondState.getTreasuryMetrics = call;
    const first = renderHook(() => useTreasuryMetrics());
    await waitFor(() => expect(first.result.current.metrics).not.toBeNull());
    expect(call).toHaveBeenCalledTimes(1);

    const second = renderHook(() => useTreasuryMetrics());
    await waitFor(() =>
      expect(second.result.current.metrics?.treasuryBalanceUsd).toBe(1),
    );
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('reload() invalidates the cache and re-fetches', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce([ONE_USD_18, 0n, 0n, 0n])
      .mockResolvedValueOnce([2n * ONE_USD_18, 0n, 0n, 0n]);
    diamondState.getTreasuryMetrics = call;
    const { result } = renderHook(() => useTreasuryMetrics());
    await waitFor(() =>
      expect(result.current.metrics?.treasuryBalanceUsd).toBe(1),
    );
    await act(async () => {
      await result.current.reload();
    });
    await waitFor(() =>
      expect(result.current.metrics?.treasuryBalanceUsd).toBe(2),
    );
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('__clearTreasuryMetricsCache forces a cold read on the next mount', async () => {
    const call = vi
      .fn()
      .mockResolvedValue([ONE_USD_18, 0n, 0n, 0n]);
    diamondState.getTreasuryMetrics = call;
    const first = renderHook(() => useTreasuryMetrics());
    await waitFor(() => expect(first.result.current.metrics).not.toBeNull());
    expect(call).toHaveBeenCalledTimes(1);
    __clearTreasuryMetricsCache();
    const second = renderHook(() => useTreasuryMetrics());
    await waitFor(() => expect(second.result.current.metrics).not.toBeNull());
    expect(call).toHaveBeenCalledTimes(2);
  });
});
