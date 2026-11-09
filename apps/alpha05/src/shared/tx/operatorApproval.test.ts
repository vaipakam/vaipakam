import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from 'wagmi';
import type { OwnStateClient } from '../../chain/ownRail';
import type { Erc1155State } from '../nft/nft';

type Hex = `0x${string}`;
const ASSET: Hex = '0x1111111111111111111111111111111111111111';
const WALLET: Hex = '0x2222222222222222222222222222222222222222';
const DIAMOND: Hex = '0x3333333333333333333333333333333333333333';

const sent: { operator: Hex; on: boolean }[] = [];
vi.mock('wagmi/actions', () => ({
  writeContract: vi.fn(async (_c: unknown, req: { args: [Hex, boolean] }) => {
    sent.push({ operator: req.args[0], on: req.args[1] });
    return '0xabc';
  }),
  waitForTransactionReceipt: vi.fn(async () => ({ blockNumber: 20n })),
}));

/** The token's state as each read finds it, in order; the last repeats. */
let states: Erc1155State[] = [];
vi.mock('../nft/nft', async (orig) => ({
  ...(await orig<typeof import('../nft/nft')>()),
  readErc1155: vi.fn(async () => (states.length > 1 ? states.shift()! : states[0]!)),
}));

const { operatorApproval } = await import('./operatorApproval');
const { waitForTransactionReceipt } = await import('wagmi/actions');
const { readErc1155 } = await import('../nft/nft');

const at = (approvedForAll: boolean): Erc1155State => ({ balance: 5n, approvedForAll, blockNumber: 1n });
/** A client whose head is block 15, behind the grant's receipt (block 20). */
const client = { getBlockNumber: vi.fn(async () => 15n) };
const own = { account: WALLET, read: async <T>(fn: (c: never) => Promise<T>) => ({ value: await fn(client as never), via: 'wallet' }) } as unknown as OwnStateClient;
const copy = { text: (k: string) => k, format: (k: string) => k } as never;
const steps: (string | null)[] = [];
const make = () => operatorApproval({ own, config: {} as Config, chainId: 1, diamond: DIAMOND, copy, collection: 'vMULTI', setStep: (s) => steps.push(s) }, ASSET, 7n);

beforeEach(() => {
  sent.length = 0;
  steps.length = 0;
});

describe('granting the operator approval for one action', () => {
  it('grants the protocol and counts it only when it reads back', async () => {
    states = [at(false), at(true)];
    await expect(make().grant()).resolves.toBe(20n);
    expect(sent).toEqual([{ operator: DIAMOND, on: true }]);
  });
  it('refuses before any prompt when it was granted since the review', async () => {
    states = [at(true)];
    await expect(make().grant()).rejects.toMatchObject({ refusal: { code: 'OperatorApprovalChanged' } });
    expect(sent).toEqual([]);
  });
  it('states a grant that did not read back, whatever the receipt said', async () => {
    states = [at(false), at(false)];
    await expect(make().grant()).rejects.toMatchObject({ refusal: { code: 'OperatorApprovalNotSet' } });
  });
  /** Fails the reads `failing` names (1 is the read before the prompt). */
  const flakyAt = (failing: (n: number) => boolean) => {
    let calls = 0;
    const flaky = {
      account: WALLET,
      read: async <T>(fn: (c: never) => Promise<T>) => {
        if (failing(++calls)) throw new Error('rpc down');
        return { value: await fn(client as never), via: 'wallet' };
      },
    } as unknown as OwnStateClient;
    return operatorApproval({ own: flaky, config: {} as Config, chainId: 1, diamond: DIAMOND, copy, collection: 'vMULTI', setStep: () => {} }, ASSET, 7n);
  };
  it('takes back a mined grant whose read-back failed before it throws', async () => {
    states = [at(false), at(true), at(false)];
    await expect(flakyAt((n) => n === 2).grant()).rejects.toMatchObject({
      refusal: { code: 'OperatorApprovalUnverified', reason: 'operatorApproval.unreadMined operatorApproval.revoked' },
    });
    expect(sent).toEqual([
      { operator: DIAMOND, on: true },
      { operator: DIAMOND, on: false },
    ]);
  });
  it('states a take-back it could not make, never as done', async () => {
    states = [at(false)];
    await expect(flakyAt((n) => n > 1).grant()).rejects.toMatchObject({
      refusal: { code: 'OperatorApprovalUnverified', reason: 'operatorApproval.unreadMined operatorApproval.revokeFailed' },
    });
    expect(sent).toEqual([{ operator: DIAMOND, on: true }]);
  });
  it('states a grant whose receipt never read as unverified, with its transaction, and sends nothing over it', async () => {
    states = [at(false)];
    vi.mocked(waitForTransactionReceipt).mockRejectedValueOnce(new Error('timeout'));
    await expect(make().grant()).rejects.toMatchObject({ refusal: { code: 'OperatorApprovalUnverified', reason: 'operatorApproval.unread' } });
    expect(sent).toEqual([{ operator: DIAMOND, on: true }]);
  });
});

describe('taking it back', () => {
  it('needs no prompt when it already reads revoked', async () => {
    states = [at(false)];
    expect(await make().revoke(20n)).toEqual({ status: 'done', sentence: 'operatorApproval.revoked' });
    expect(sent).toEqual([]);
  });
  it('revokes while it still reads granted, judged by the read back, naming the step', async () => {
    states = [at(true), at(false)];
    expect(await make().revoke(20n)).toEqual({ status: 'done', sentence: 'operatorApproval.revoked' });
    expect(sent).toEqual([{ operator: DIAMOND, on: false }]);
    expect(steps).toEqual(['operatorApproval.stepRevoke', null]);
    states = [at(true), at(true)];
    expect(await make().revoke(20n)).toEqual({ status: 'not-done', sentence: 'operatorApproval.revokeNotLanded' });
  });
  it('never reads at a block before the grant, so a revoke is never skipped as already done', async () => {
    states = [at(true), at(false)];
    vi.mocked(readErc1155).mockClear();
    await make().revoke(20n);
    // The head reads 15, the grant mined at 20: the first read is at 20.
    expect(vi.mocked(readErc1155).mock.calls[0]![5]).toBe(20n);
    expect(client.getBlockNumber).toHaveBeenCalledWith({ cacheTime: 0 });
  });
  it('states a sent revoke whose receipt could not be read as unknown, never as not landed', async () => {
    states = [at(true)];
    vi.mocked(waitForTransactionReceipt).mockRejectedValueOnce(new Error('timeout'));
    expect(await make().revoke(20n)).toEqual({ status: 'unknown', sentence: 'operatorApproval.revokePending' });
  });
  it('states a revoke that failed outright instead of throwing', async () => {
    const broken = { account: WALLET, read: async () => Promise.reject(new Error('rpc down')) } as unknown as OwnStateClient;
    const ap = operatorApproval({ own: broken, config: {} as Config, chainId: 1, diamond: DIAMOND, copy, collection: 'vMULTI', setStep: () => {} }, ASSET, 7n);
    await expect(ap.revoke(20n)).resolves.toMatchObject({ status: 'not-done', sentence: 'operatorApproval.revokeFailed' });
  });
});
