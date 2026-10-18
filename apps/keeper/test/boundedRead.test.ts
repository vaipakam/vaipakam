/**
 * #2497 r18–r19 — the one read helper of a pass with a run deadline: nothing
 * is issued past the deadline, and a rejected aggregate costs one request and
 * reads as unread, never one serial request per entry.
 */
import { describe, expect, it } from 'vitest';
import { PastRunDeadline, boundedRead, deadlineClient } from '../src/batchRead';

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
});
