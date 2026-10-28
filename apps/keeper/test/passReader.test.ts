/**
 * #2984 — the step passes' shared reader stops every read at the run's read
 * cutoff (the send deadline less the send reserve, `runWindow.ts` rule 3):
 * a read not yet made is refused there, and one still in flight is
 * abandoned there, so a slow read can never use the time the sends need.
 */
import { describe, expect, it } from 'vitest';
import type { Abi, Address, PublicClient } from 'viem';
import { boundedCall, PassReader } from '../src/passReader';
import { PastRunDeadline } from '../src/batchRead';
import { SEND_RESERVE_MS } from '../src/runWindow';

const DIAMOND: Address = '0x00000000000000000000000000000000000000c1';
const ABI = [{ type: 'function', name: 'x', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' }] as Abi;
const later = <T>(ms: number, v: T) => new Promise<T>((resolve) => setTimeout(() => resolve(v), ms));

function client(delayMs: number): PublicClient {
  return {
    readContract: () => later(delayMs, 7n),
    multicall: ({ contracts }: { contracts: unknown[] }) => later(delayMs, contracts.map(() => ({ status: 'success', result: 7n }))),
    getBlock: async () => ({ number: 1n, timestamp: 1n }),
  } as unknown as PublicClient;
}

const reader = (delayMs: number, msToCutoff: number) => {
  const c = client(delayMs);
  return new PassReader({ client: c, readClient: c }, Date.now() + SEND_RESERVE_MS + msToCutoff, DIAMOND, ABI, 'test');
};

describe('PassReader', () => {
  it('reads normally before the cutoff', async () => {
    const r = reader(1, 5_000);
    expect(await r.one('x')).toBe(7n);
    expect(await r.many([{ functionName: 'x', args: [] }], 'xs')).toEqual([7n]);
  });

  it('sits its cutoff a send reserve before the send deadline', () => {
    const deadline = Date.now() + 60_000;
    const c = client(1);
    expect(new PassReader({ client: c, readClient: c }, deadline, DIAMOND, ABI, 'test').cutoff).toBe(deadline - SEND_RESERVE_MS);
  });

  it('abandons a single read still in flight at the cutoff', async () => {
    const r = reader(2_000, 50);
    const t0 = Date.now();
    await expect(r.one('x')).rejects.toBeInstanceOf(PastRunDeadline);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it('refuses a read started after the cutoff, before the send deadline', async () => {
    const r = reader(1, -1);
    await expect(r.one('x')).rejects.toBeInstanceOf(PastRunDeadline);
  });

  it('gives a batch still in flight at the cutoff as unread', async () => {
    const r = reader(2_000, 50);
    const t0 = Date.now();
    const out = await r.many([{ functionName: 'x', args: [] }], 'xs');
    expect(out).toEqual([undefined]);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});

describe('boundedCall', () => {
  it('returns the work before the cutoff', async () => {
    expect(await boundedCall(Date.now() + 5_000, 'x', () => later(1, 3))).toBe(3);
  });

  it('refuses work not yet started once the cutoff has passed, without starting it', async () => {
    let started = false;
    await expect(
      boundedCall(Date.now() - 1, 'x', async () => {
        started = true;
        return 1;
      }),
    ).rejects.toBeInstanceOf(PastRunDeadline);
    expect(started).toBe(false);
  });

  it('abandons work still in flight at the cutoff', async () => {
    const t0 = Date.now();
    await expect(boundedCall(Date.now() + 50, 'x', () => later(2_000, 1))).rejects.toBeInstanceOf(PastRunDeadline);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it('passes the work\'s own failure through', async () => {
    await expect(boundedCall(Date.now() + 5_000, 'x', () => Promise.reject(new Error('rpc down')))).rejects.toThrow('rpc down');
  });
});
