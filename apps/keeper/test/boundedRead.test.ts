/**
 * #2497 r18–r19 — the one read helper of a pass with a run deadline: nothing
 * is issued past the deadline, and a rejected aggregate costs one request and
 * reads as unread, never one serial request per entry.
 */
import { describe, expect, it } from 'vitest';
import { PastRunDeadline, boundedRead, deadlineClient, settledChunkedRead, settledRead } from '../src/batchRead';

function client(behaviour: 'reject' | 'ok') {
  const calls = { multicall: 0, readContract: 0 };
  const c = {
    multicall: async ({ contracts }: { contracts: unknown[] }) => {
      calls.multicall += 1;
      if (behaviour === 'reject') throw new Error('aggregate rejected');
      return contracts.map(() => ({ status: 'success', result: 1 }));
    },
    readContract: async () => {
      calls.readContract += 1;
      return 1;
    },
  };
  return { c: c as never, calls };
}

describe('boundedRead', () => {
  const contracts = Array.from({ length: 100 }, () => ({}));

  it('a rejected aggregate costs ONE request and reads as unread — no serial fallback', async () => {
    const { c, calls } = client('reject');
    const res = await boundedRead(c, contracts, 'test', Date.now() + 60_000);
    expect(calls).toEqual({ multicall: 1, readContract: 0 });
    expect(res.every((r) => r.status === 'failure')).toBe(true);
  });

  it('past the deadline it issues nothing', async () => {
    const { c, calls } = client('ok');
    const res = await boundedRead(c, contracts, 'test', Date.now() - 1);
    expect(calls).toEqual({ multicall: 0, readContract: 0 });
    expect(res).toHaveLength(100);
    expect(res.every((r) => r.status === 'failure')).toBe(true);
  });

  it('reads normally inside the deadline', async () => {
    const { c } = client('ok');
    const res = await boundedRead(c, contracts, 'test', Date.now() + 60_000);
    expect(res.every((r) => r.status === 'success')).toBe(true);
  });
});

describe('settledRead — a read in flight at the deadline is abandoned (Codex #2607 r7)', () => {
  const contracts = Array.from({ length: 3 }, () => ({}));

  it('settles at the deadline as unread when the aggregate is still in flight', async () => {
    const stalled = { multicall: () => new Promise(() => {}), readContract: async () => 1 };
    const started = Date.now();
    const res = await settledRead(stalled as never, contracts, 'test', Date.now() + 100);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(res).toHaveLength(3);
    expect(res.every((r) => r.status === 'failure')).toBe(true);
  });

  it('returns the read itself when it answers in time', async () => {
    const { c } = client('ok');
    const res = await settledRead(c, contracts, 'test', Date.now() + 60_000);
    expect(res.every((r) => r.status === 'success')).toBe(true);
  });
});

describe('settledChunkedRead — a cutoff never strands the same tail (Codex #2607 r16)', () => {
  it('over runs, reaches every key even when one key\'s chunk always stalls to the cutoff', async () => {
    const keys = Array.from({ length: 250 }, (_, i) => i);
    // The chunk holding key 0 never answers, and every chunk after it in that
    // run is refused at the cutoff, as on a live stalled RPC.
    const stalling = {
      multicall: ({ contracts }: { contracts: { key: number }[] }) =>
        contracts.some((c) => c.key === 0)
          ? new Promise(() => {})
          : Promise.resolve(contracts.map(() => ({ status: 'success', result: 1 }))),
      readContract: async () => 1,
    };
    const reached = new Set<number>();
    for (let run = 0; run < 250; run++) {
      // eslint-disable-next-line no-await-in-loop
      const res = await settledChunkedRead(stalling as never, keys, 100, (key) => ({ key }), 'test', Date.now() + 5, run);
      expect(res.size).toBe(keys.length);
      for (const [k, r] of res) if (r.status === 'success') reached.add(k);
    }
    expect(reached.size).toBe(keys.length - 1);
  });
});

describe('deadlineClient — every read of a deadline-bound pass, one guard (#2497 re-cut)', () => {
  it('refuses reads past the deadline and passes everything else through', async () => {
    let reads = 0;
    const base = { readContract: async () => { reads += 1; return 7; }, getChainId: async () => 1 };
    const open = deadlineClient(base, Date.now() + 60_000);
    expect(await open.readContract()).toBe(7);
    const closed = deadlineClient(base, Date.now() - 1);
    expect(() => closed.readContract()).toThrow(PastRunDeadline);
    expect(reads, 'nothing issued past the deadline').toBe(1);
    expect(await closed.getChainId(), 'an unguarded method is untouched').toBe(1);
  });

  it('refuses the code and storage reads a report-shape probe makes', () => {
    let reads = 0;
    const base = { getCode: async () => { reads += 1; return '0x'; }, getStorageAt: async () => { reads += 1; return '0x'; } };
    const closed = deadlineClient(base, Date.now() - 1);
    expect(() => closed.getCode()).toThrow(PastRunDeadline);
    expect(() => closed.getStorageAt()).toThrow(PastRunDeadline);
    expect(reads).toBe(0);
  });
});

describe('the submission queue honours a run deadline at the send\'s turn (#2571 r1)', () => {
  it('refuses inside the slot, before signing, once the deadline has passed', async () => {
    const { queuedWallet, SendPastDeadline } = await import('../src/submissionQueue');
    // The epoch fence holds (as a tick arms it), so the refusal is the DEADLINE's.
    const { armHeldFence } = await import('./helpers/epochFence');
    armHeldFence([{ id: 84532, diamond: `0x${'1'.repeat(40)}` }]);
    const { createWalletClient, custom } = await import('viem');
    const { privateKeyToAccount } = await import('viem/accounts');
    const account = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
    const calls: string[] = [];
    const transport = custom({
      request: async ({ method }: { method: string }) => {
        calls.push(method);
        if (method === 'eth_getTransactionCount') return '0x0';
        if (method === 'eth_chainId') return '0x14a34';
        throw new Error(`unexpected ${method}`);
      },
    });
    const wallet = queuedWallet(createWalletClient({ account, transport }), 84532, Date.now() - 1);
    await expect(wallet.sendTransaction({ to: account.address, value: 0n, chain: null } as never)).rejects.toBeInstanceOf(SendPastDeadline);
    expect(calls.filter((m) => m.startsWith('eth_send')), 'nothing broadcast').toEqual([]);
  });
});
