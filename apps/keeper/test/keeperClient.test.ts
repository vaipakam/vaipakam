/**
 * #2497 r21 — the keeper's read client is bound by the run's deadline at its
 * transport: past the deadline no request leaves the process, whatever
 * action issued it; inside it every request passes through unchanged.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPublicClient, custom } from 'viem';
import { deadlineBoundTransport } from '../src/keeperClient';
import { isRunDeadlinePassed } from '../src/runDeadline';

function clientOn(deadlineMs: number, seen: string[]) {
  const inner = custom({
    request: async ({ method }: { method: string }) => {
      seen.push(method);
      if (method === 'eth_blockNumber') return '0x10';
      if (method === 'eth_chainId') return '0x1';
      if (method === 'eth_getTransactionReceipt') return null;
      throw new Error(`unexpected ${method}`);
    },
  });
  return createPublicClient({ transport: deadlineBoundTransport(inner, deadlineMs) });
}

describe('deadlineBoundTransport', () => {
  afterEach(() => vi.useRealTimers());

  it('passes every request through inside the deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const seen: string[] = [];
    const client = clientOn(10_000, seen);
    expect(await client.getBlockNumber()).toBe(16n);
    expect(await client.getChainId()).toBe(1);
    expect(seen).toEqual(['eth_blockNumber', 'eth_chainId']);
  });

  it('refuses every request once the deadline has passed, before it leaves the process', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const seen: string[] = [];
    const client = clientOn(10_000, seen);
    await client.getBlockNumber();
    vi.setSystemTime(10_000);
    // A read, a receipt poll and a chain id alike: nothing is special-cased.
    await expect(client.getBlockNumber()).rejects.toSatisfy(isRunDeadlinePassed);
    await expect(client.getTransactionReceipt({ hash: `0x${'1'.repeat(64)}` })).rejects.toSatisfy(isRunDeadlinePassed);
    await expect(client.getChainId()).rejects.toSatisfy(isRunDeadlinePassed);
    expect(seen, 'only the request made inside the deadline reached the RPC').toEqual(['eth_blockNumber']);
  });

  it('names the refused method in the refusal', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const err = await clientOn(10_000, []).getBlockNumber().then(() => null, (e: unknown) => e);
    expect(String((err as Error).message)).toMatch(/eth_blockNumber: past the run deadline/);
  });
});
