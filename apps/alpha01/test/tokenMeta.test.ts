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

import { fetchTokenMeta, hasResolvedTokenDecimals, resetTokenMetaCacheForTests } from '../src/lib/tokenMeta';

const CHAIN_A = 84532;
const CHAIN_B = 421614;

describe('fetchTokenMeta', () => {
  beforeEach(() => {
    read.symbol.mockReset();
    read.decimals.mockReset();
    localStorage.clear();
    resetTokenMetaCacheForTests();
  });

  it('does not treat fallback decimals as resolved when decimals() fails', async () => {
    const token = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
    read.symbol.mockResolvedValue('USDC');
    read.decimals.mockRejectedValue(new Error('rpc timeout'));

    const meta = await fetchTokenMeta(token, {} as PublicClient, CHAIN_A);
    expect(meta.symbol).toBe('USDC');
    expect(meta.decimals).toBe(0);
    expect(hasResolvedTokenDecimals(meta, token, CHAIN_A)).toBe(false);
  });

  it('caches per chain so the same address on another chain re-fetches', async () => {
    const token = '0x4200000000000000000000000000000000000006';
    read.symbol.mockResolvedValueOnce('WETH').mockResolvedValueOnce('WETH');
    read.decimals.mockResolvedValueOnce(18).mockResolvedValueOnce(8);

    const onA = await fetchTokenMeta(token, {} as PublicClient, CHAIN_A);
    const onB = await fetchTokenMeta(token, {} as PublicClient, CHAIN_B);

    expect(onA.decimals).toBe(18);
    expect(onB.decimals).toBe(8);
    expect(hasResolvedTokenDecimals(onA, token, CHAIN_A)).toBe(true);
    expect(hasResolvedTokenDecimals(onB, token, CHAIN_B)).toBe(true);
  });
});