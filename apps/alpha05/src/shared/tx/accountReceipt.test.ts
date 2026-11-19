import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Config } from 'wagmi';

const state = vi.hoisted(() => ({
  connector: null as null | { id: string; getProvider: () => Promise<unknown> },
  waited: [] as string[],
  logs: [] as { address: string; topics: string[]; data: string }[],
}));

vi.mock('wagmi/actions', () => ({
  getAccount: () => ({ connector: state.connector, address: SAFE }),
  getPublicClient: () => null,
  waitForTransactionReceipt: vi.fn(async (_c: unknown, { hash }: { hash: string }) => {
    state.waited.push(hash);
    return { status: 'success', blockNumber: 7n, logs: state.logs };
  }),
}));

const SAFE = ('0x' + '5a'.repeat(20)) as `0x${string}`;
const ID = ('0x' + 'd'.repeat(64)) as `0x${string}`;
const CHAIN = ('0x' + 'c'.repeat(64)) as `0x${string}`;
const { AccountTxEnded, SAFE_EXECUTION_FAILURE, SAFE_EXECUTION_SUCCESS, waitForSentReceipt } = await import('./accountWallet');
const config = {} as Config;
const safeApp = (details: Record<string, unknown>) => ({ id: 'safe', getProvider: async () => ({ sdk: { txs: { getBySafeTxHash: async () => details } } }) });

beforeEach(() => {
  state.connector = null;
  state.waited = [];
  state.logs = [];
});

describe('waitForSentReceipt (every intermediate step)', () => {
  it('waits on the hash itself for any wallet that is not a Safe App', async () => {
    const r = await waitForSentReceipt(config, CHAIN, 1);
    expect(state.waited).toEqual([CHAIN]);
    expect(r.blockNumber).toBe(7n);
  });
  it('follows a Safe id to the chain hash it ran under', async () => {
    state.connector = safeApp({ txStatus: 'SUCCESS', txHash: CHAIN });
    state.logs = [{ address: SAFE, topics: [SAFE_EXECUTION_SUCCESS], data: ID + '0'.repeat(64) }];
    const r = await waitForSentReceipt(config, ID, 1);
    expect(state.waited).toEqual([CHAIN]);
    expect(r.status).toBe('success');
  });
  it('reads a call the wallet logged as failed as reverted, though the outer transaction mined', async () => {
    state.connector = safeApp({ txStatus: 'FAILED', txHash: CHAIN });
    state.logs = [{ address: SAFE, topics: [SAFE_EXECUTION_FAILURE], data: ID + '0'.repeat(64) }];
    expect((await waitForSentReceipt(config, ID, 1)).status).toBe('reverted');
  });
  it('throws when the owners reject the step, and waits on nothing', async () => {
    state.connector = safeApp({ txStatus: 'CANCELLED', txHash: null });
    await expect(waitForSentReceipt(config, ID, 1)).rejects.toBeInstanceOf(AccountTxEnded);
    expect(state.waited).toEqual([]);
  });
});
