import { ContractFunctionRevertedError, parseAbi, type PublicClient } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import type { OwnStateClient, OwnStateSource } from '../../chain/ownRail';
import { askAfter, askSources, askThrough } from './simulate';

const abi = parseAbi(['function ownerOf(uint256) view returns (address)']);
const revert = () => new ContractFunctionRevertedError({ abi, functionName: 'ownerOf', message: 'ERC721NonexistentToken' });
const own = (n: number): OwnStateClient =>
  ({
    chainId: 84532,
    account: '0x0000000000000000000000000000000000000001',
    walletFirst: true,
    sources: Array.from({ length: n }, (_, i) => ({ via: i === 0 ? 'wallet' : 'proxy', client: { id: i } as unknown as PublicClient })),
    read: () => Promise.reject(new Error('unused')),
  }) as OwnStateClient;

describe('askThrough', () => {
  it('stops at a revert: the contract answered', async () => {
    let calls = 0;
    const r = await askThrough(own(2), async () => {
      calls += 1;
      throw revert();
    });
    expect(r.kind).toBe('reverted');
    expect(calls).toBe(1);
  });

  it('passes over a source that cannot run the call', async () => {
    const r = await askThrough(own(2), async (c) => {
      if ((c as unknown as { id: number }).id === 0) throw new Error('timeout');
      return 'answer';
    });
    expect(r).toEqual({ kind: 'answered', value: 'answer' });
  });

  it('is unreadable, never a negative answer, when no source can run it', async () => {
    const r = await askThrough(own(2), async () => {
      throw new Error('fetch failed\nmore detail');
    });
    expect(r).toEqual({ kind: 'unreadable', reason: 'fetch failed' });
  });
});

describe('askAfter', () => {
  const at = (heads: bigint[]): OwnStateClient =>
    ({
      chainId: 84532,
      account: '0x0000000000000000000000000000000000000001',
      walletFirst: true,
      sources: heads.map((h, i) => ({ via: i === 0 ? 'wallet' : 'proxy', client: { id: i, getBlockNumber: async () => h } as unknown as PublicClient })),
      read: () => Promise.reject(new Error('unused')),
    }) as OwnStateClient;

  it('passes over a source behind the approval block and asks the next one at its head', async () => {
    const seen: [number, bigint | undefined][] = [];
    const r = await askAfter(at([99n, 105n]), 100n, async (c, b) => {
      seen.push([(c as unknown as { id: number }).id, b]);
      return 'ok';
    });
    expect(r).toEqual({ kind: 'answered', value: 'ok' });
    expect(seen).toEqual([[1, 105n]]);
  });

  it('says the check could not be run when every source stays behind, never a refusal', async () => {
    const r = await askAfter(at([90n, 95n]), 100n, async () => 'ok', { tries: 2, waitMs: 1 });
    expect(r.kind).toBe('unreadable');
  });

  it('keeps a revert as the answer', async () => {
    const r = await askAfter(at([100n]), 100n, async () => {
      throw revert();
    });
    expect(r.kind).toBe('reverted');
  });

  it('with nothing sent first, asks at the latest block', async () => {
    const r = await askAfter(at([1n]), null, async (_c, b) => b);
    expect(r).toEqual({ kind: 'answered', value: undefined });
  });
});

describe('a source that never answers', () => {
  it('is passed over after the deadline and the next source answers', async () => {
    vi.useFakeTimers();
    try {
      const hung = { via: 'wallet', client: {} } as unknown as OwnStateSource;
      const live = { via: 'public', client: { ok: true } } as unknown as OwnStateSource;
      const asked = askSources([hung, live], (c) => ((c as unknown as { ok?: boolean }).ok ? Promise.resolve(7) : new Promise<number>(() => {})));
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await asked).toEqual({ kind: 'answered', value: 7 });
    } finally {
      vi.useRealTimers();
    }
  });
});
