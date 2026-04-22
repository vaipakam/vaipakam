import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock ethers Contract — each token call uses a module-scoped stub so tests
// can control symbol()/decimals() behavior per-case.
const contractState: {
  symbol: () => Promise<string>;
  decimals: () => Promise<bigint | number>;
} = {
  symbol: vi.fn(),
  decimals: vi.fn(),
};

vi.mock('ethers', () => {
  class ContractMock {
    constructor(public address: string) {}
    symbol() {
      return contractState.symbol();
    }
    decimals() {
      return contractState.decimals();
    }
  }
  return { Contract: ContractMock };
});

import { fetchTokenMeta } from '../../src/lib/tokenMeta';

const ZERO = '0x0000000000000000000000000000000000000000';
const USDC = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const WETH = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const BROKEN = '0xcccccccccccccccccccccccccccccccccccccccc';

function mkDiamond(): { runner: { provider: Record<string, never> } } {
  return { runner: { provider: {} } };
}

beforeEach(() => {
  // Module-scoped caches survive between tests; use fresh addresses per test
  // to avoid accidental cross-contamination. Also wipe localStorage so the
  // persist/seed round-trip doesn't feed stale symbols back in.
  localStorage.clear();
  contractState.symbol = vi.fn();
  contractState.decimals = vi.fn();
});

describe('fetchTokenMeta', () => {
  it('short-circuits the native (zero) address without hitting the chain', async () => {
    const calls = vi.fn();
    contractState.symbol = calls;
    const meta = await fetchTokenMeta(ZERO, mkDiamond());
    expect(meta).toEqual({ address: ZERO, symbol: 'ETH', decimals: 18 });
    expect(calls).not.toHaveBeenCalled();
  });

  it('returns a best-effort fallback when no provider is available', async () => {
    contractState.symbol = vi.fn().mockResolvedValue('X');
    const meta = await fetchTokenMeta(USDC, null);
    expect(meta).toEqual({ address: USDC, symbol: '', decimals: 18 });
  });

  it('reads symbol + decimals off the ERC-20 contract', async () => {
    contractState.symbol = vi.fn().mockResolvedValue('USDC');
    contractState.decimals = vi.fn().mockResolvedValue(6n);
    const meta = await fetchTokenMeta(USDC, mkDiamond());
    expect(meta).toEqual({ address: USDC, symbol: 'USDC', decimals: 6 });
  });

  it('falls back to empty symbol / 18 decimals when RPC calls reject', async () => {
    // Fresh address → uncached. Both RPC calls reject → inner catches swallow them.
    contractState.symbol = vi.fn().mockRejectedValue(new Error('no symbol'));
    contractState.decimals = vi.fn().mockRejectedValue(new Error('no decimals'));
    const meta = await fetchTokenMeta(BROKEN, mkDiamond());
    expect(meta).toEqual({ address: BROKEN, symbol: '', decimals: 18 });
  });

  it('caches the second lookup — no RPC call on repeat hits', async () => {
    const newAddr = '0xdddddddddddddddddddddddddddddddddddddddd';
    contractState.symbol = vi.fn().mockResolvedValue('WETH');
    contractState.decimals = vi.fn().mockResolvedValue(18n);
    const first = await fetchTokenMeta(newAddr, mkDiamond());
    expect(first.symbol).toBe('WETH');
    expect(contractState.symbol).toHaveBeenCalledTimes(1);
    const second = await fetchTokenMeta(newAddr, mkDiamond());
    expect(second).toEqual(first);
    expect(contractState.symbol).toHaveBeenCalledTimes(1); // still 1 — cache hit
  });

  it('deduplicates concurrent lookups into a single in-flight request', async () => {
    const newAddr = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const sym = vi.fn().mockImplementation(
      () => new Promise<string>((r) => setTimeout(() => r('DAI'), 20)),
    );
    contractState.symbol = sym;
    contractState.decimals = vi.fn().mockResolvedValue(18n);
    const [a, b] = await Promise.all([
      fetchTokenMeta(newAddr, mkDiamond()),
      fetchTokenMeta(newAddr, mkDiamond()),
    ]);
    expect(a).toEqual(b);
    expect(a.symbol).toBe('DAI');
    // Both callers share the same inflight promise → exactly one RPC.
    expect(sym).toHaveBeenCalledTimes(1);
  });

  it('lowercases the address in the returned meta', async () => {
    const addr = '0xFFFFffffFFffFFffFfffFfFFFffFFFFFFFffFfff';
    contractState.symbol = vi.fn().mockResolvedValue('UP');
    contractState.decimals = vi.fn().mockResolvedValue(18n);
    const meta = await fetchTokenMeta(addr, mkDiamond());
    expect(meta.address).toBe(addr.toLowerCase());
  });
});
