import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicClient } from 'viem';

const read = {
  symbol: vi.fn(),
  decimals: vi.fn(),
};

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    getContract: () => ({ read }),
  };
});

import { fetchTokenMeta, hasResolvedTokenDecimals } from '../src/lib/tokenMeta';

describe('fetchTokenMeta', () => {
  beforeEach(() => {
    read.symbol.mockReset();
    read.decimals.mockReset();
    localStorage.clear();
  });

  it('does not treat fallback decimals as resolved when decimals() fails', async () => {
    const token = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
    read.symbol.mockResolvedValue('USDC');
    read.decimals.mockRejectedValue(new Error('rpc timeout'));

    const meta = await fetchTokenMeta(token, {} as PublicClient);
    expect(meta.symbol).toBe('USDC');
    expect(meta.decimals).toBe(18);
    expect(hasResolvedTokenDecimals(meta, token)).toBe(false);
  });

  it('caches only when symbol and decimals both succeed', async () => {
    const token = '0x4200000000000000000000000000000000000006';
    read.symbol.mockResolvedValue('WETH');
    read.decimals.mockResolvedValue(18);

    const meta = await fetchTokenMeta(token, {} as PublicClient);
    expect(meta.decimals).toBe(18);
    expect(hasResolvedTokenDecimals(meta, token)).toBe(true);
  });
});