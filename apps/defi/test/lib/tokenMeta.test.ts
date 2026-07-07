import { describe, it, expect, vi, beforeEach } from 'vitest';

// #1076: `tokenMeta` migrated off ethers to viem — `fetchTokenMeta` now
// resolves symbol()/decimals() via `getContract({ address, abi, client })
// .read.*`, which dispatches to `client.readContract({ functionName })`.
// The old `vi.mock('ethers', …)` Contract stub is dead (src imports no
// ethers). We keep the same module-scoped `symbol`/`decimals` vi.fns —
// the call-count assertions below count them — and route them through a
// fake viem PublicClient's `readContract`.
const contractState: {
  symbol: () => Promise<string>;
  decimals: () => Promise<bigint | number>;
} = {
  symbol: vi.fn(),
  decimals: vi.fn(),
};

import { fetchTokenMeta } from '../../src/lib/tokenMeta';

const ZERO = '0x0000000000000000000000000000000000000000';
const USDC = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const WETH = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const BROKEN = '0xcccccccccccccccccccccccccccccccccccccccc';

// #1076: fake viem PublicClient. `getContract(...).read.symbol()` calls
// `client.readContract({ address, abi, functionName: 'symbol', args })`;
// we dispatch each `functionName` back to the per-case `contractState`
// stub so the existing behaviour-driving + call-count assertions hold.
function mkClient(): { readContract: (a: { functionName: string }) => Promise<unknown> } {
  return {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'symbol') return contractState.symbol();
      if (functionName === 'decimals') return contractState.decimals();
      throw new Error(`unexpected functionName ${functionName}`);
    },
  };
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
    const meta = await fetchTokenMeta(ZERO, mkClient() as any);
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
    const meta = await fetchTokenMeta(USDC, mkClient() as any);
    expect(meta).toEqual({ address: USDC, symbol: 'USDC', decimals: 6 });
  });

  it('falls back to empty symbol / 18 decimals when RPC calls reject', async () => {
    // Fresh address → uncached. Both RPC calls reject → inner catches swallow them.
    contractState.symbol = vi.fn().mockRejectedValue(new Error('no symbol'));
    contractState.decimals = vi.fn().mockRejectedValue(new Error('no decimals'));
    const meta = await fetchTokenMeta(BROKEN, mkClient() as any);
    expect(meta).toEqual({ address: BROKEN, symbol: '', decimals: 18 });
  });

  it('caches the second lookup — no RPC call on repeat hits', async () => {
    const newAddr = '0xdddddddddddddddddddddddddddddddddddddddd';
    contractState.symbol = vi.fn().mockResolvedValue('WETH');
    contractState.decimals = vi.fn().mockResolvedValue(18n);
    const first = await fetchTokenMeta(newAddr, mkClient() as any);
    expect(first.symbol).toBe('WETH');
    expect(contractState.symbol).toHaveBeenCalledTimes(1);
    const second = await fetchTokenMeta(newAddr, mkClient() as any);
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
      fetchTokenMeta(newAddr, mkClient() as any),
      fetchTokenMeta(newAddr, mkClient() as any),
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
    const meta = await fetchTokenMeta(addr, mkClient() as any);
    expect(meta.address).toBe(addr.toLowerCase());
  });
});
