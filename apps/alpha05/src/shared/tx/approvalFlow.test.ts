import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from 'wagmi';
import type { OwnStateClient } from '../../chain/ownRail';

type Hex = `0x${string}`;
const TOKEN: Hex = '0x1111111111111111111111111111111111111111';
const WALLET: Hex = '0x2222222222222222222222222222222222222222';
const DIAMOND: Hex = '0x3333333333333333333333333333333333333333';

const sent: bigint[] = [];
vi.mock('wagmi/actions', () => ({
  writeContract: vi.fn(async (_c: unknown, req: { args: [Hex, bigint] }) => {
    sent.push(req.args[1]);
    allowance = req.args[1];
    return '0xabc';
  }),
  waitForTransactionReceipt: vi.fn(async () => ({ blockNumber: 21n })),
}));

const { approvalFlow } = await import('./approvalFlow');

/** The allowance the chain holds now; a read below block 20 sees the one
 *  before the approval (a node that has not caught up). */
let allowance = 0n;
const reads: (bigint | undefined)[] = [];
const client = {
  getBlockNumber: vi.fn(async () => 15n),
  readContract: vi.fn(async (req: { blockNumber?: bigint }) => {
    reads.push(req.blockNumber);
    return req.blockNumber !== undefined && req.blockNumber < 20n ? 0n : allowance;
  }),
};
const own = { account: WALLET, read: async <T>(fn: (c: never) => Promise<T>) => ({ value: await fn(client as never), via: 'wallet' }) } as unknown as OwnStateClient;
const copy = { text: (k: string) => k, format: (k: string) => k } as never;
const flow = () => approvalFlow({ own, config: {} as Config, chainId: 1, diamond: DIAMOND, copy, amount: (_t, v) => String(v), setStep: () => {} });

beforeEach(() => {
  sent.length = 0;
  reads.length = 0;
});

describe('putting an allowance back', () => {
  it('reads it no earlier than the block the approval mined in, so a lagging node cannot pass the reset as done', async () => {
    allowance = 500n;
    const back = await flow().putBack(TOKEN, 0n, 500n, 20n);
    // The head reads 15, the approval mined at 20: the allowance is read at 20.
    expect(reads[0]).toBe(20n);
    expect(client.getBlockNumber).toHaveBeenCalledWith({ cacheTime: 0 });
    expect(sent).toEqual([0n]);
    expect(back.ok).toBe(true);
  });
  it('without a known block reads the latest state', async () => {
    allowance = 0n;
    await flow().putBack(TOKEN, 0n, 500n, null);
    expect(reads[0]).toBeUndefined();
  });
});
