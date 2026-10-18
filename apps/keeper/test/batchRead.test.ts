/**
 * #2497 r18–r19 — the one bounded read helper. Every batched read in the
 * keeper carries the run's deadline: past it nothing is issued; a rejected
 * aggregate degrades to serial reads that STOP at the deadline, or, when the
 * caller asks, to unread entries at the cost of one request.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { batchedRead } from '../src/batchRead';
import { RunDeadlinePassed } from '../src/runDeadline';

function client(behaviour: 'reject' | 'ok', onRead: () => void = () => {}) {
  const calls = { multicall: 0, readContract: 0 };
  const c = {
    multicall: async ({ contracts }: { contracts: unknown[] }) => {
      calls.multicall += 1;
      if (behaviour === 'reject') throw new Error('aggregate rejected');
      return contracts.map(() => ({ status: 'success', result: 1 }));
    },
    readContract: async () => {
      calls.readContract += 1;
      onRead();
      return 1;
    },
  };
  return { c: c as never, calls };
}

describe('batchedRead — bounded by the run deadline', () => {
  const contracts = Array.from({ length: 100 }, () => ({}));
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("'unread': a rejected aggregate costs ONE request and reads as unread — no serial fallback", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { c, calls } = client('reject');
    const res = await batchedRead(c, contracts, 'test', { deadlineMs: Date.now() + 60_000, onAggregateFailure: 'unread' });
    expect(calls).toEqual({ multicall: 1, readContract: 0 });
    expect(res.every((r) => r.status === 'failure')).toBe(true);
  });

  it('past the deadline it issues nothing, and says why on every entry', async () => {
    const { c, calls } = client('ok');
    const res = await batchedRead(c, contracts, 'test', { deadlineMs: Date.now() - 1 });
    expect(calls).toEqual({ multicall: 0, readContract: 0 });
    expect(res).toHaveLength(100);
    expect(res.every((r) => r.status === 'failure' && r.error instanceof RunDeadlinePassed)).toBe(true);
  });

  it('the serial fallback (the default) reads each entry inside the deadline and STOPS at it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const deadlineMs = Date.now() + 10_000;
    // Each serial read takes 4 s of clock: the third one is reached past the deadline.
    const { c, calls } = client('reject', () => vi.setSystemTime(Date.now() + 4_000));
    const res = await batchedRead(c, contracts, 'test', { deadlineMs });
    expect(calls).toEqual({ multicall: 1, readContract: 3 });
    expect(res.slice(0, 3).every((r) => r.status === 'success')).toBe(true);
    expect(res.slice(3).every((r) => r.status === 'failure' && r.error instanceof RunDeadlinePassed)).toBe(true);
    expect(res).toHaveLength(100);
  });

  it('reads normally inside the deadline', async () => {
    const { c } = client('ok');
    const res = await batchedRead(c, contracts, 'test', { deadlineMs: Date.now() + 60_000 });
    expect(res.every((r) => r.status === 'success')).toBe(true);
  });
});
