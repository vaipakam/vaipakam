import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from 'wagmi';
import type { OwnStateClient } from '../../chain/ownRail';
import type { Erc721State } from '../nft/nft';

type Hex = `0x${string}`;
const ASSET: Hex = '0x1111111111111111111111111111111111111111';
const WALLET: Hex = '0x2222222222222222222222222222222222222222';
const DIAMOND: Hex = '0x3333333333333333333333333333333333333333';
const OTHER: Hex = '0x4444444444444444444444444444444444444444';

const sent: { to: Hex }[] = [];
vi.mock('wagmi/actions', () => ({
  writeContract: vi.fn(async (_c: unknown, req: { args: [Hex, bigint] }) => {
    sent.push({ to: req.args[0] });
    return '0xabc';
  }),
  waitForTransactionReceipt: vi.fn(async () => ({ blockNumber: 20n })),
}));

/** The token's state as each read finds it, in order; the last repeats. */
let states: Erc721State[] = [];
vi.mock('../nft/nft', async (orig) => ({
  ...(await orig<typeof import('../nft/nft')>()),
  readErc721: vi.fn(async () => (states.length > 1 ? states.shift()! : states[0]!)),
}));

const { nftApproval } = await import('./nftApproval');

const at = (owner: Hex | null, approved: Hex | null): Erc721State => ({ owner, approved, approvedForAll: false, blockNumber: 1n });
const own = { account: WALLET, read: async <T>(fn: (c: never) => Promise<T>) => ({ value: await fn(undefined as never), via: 'wallet' }) } as unknown as OwnStateClient;
const copy = { text: (k: string) => k, format: (k: string) => k } as never;
const make = () => nftApproval({ own, config: {} as Config, chainId: 1, diamond: DIAMOND, copy, tokenName: 'T #7', setStep: () => {} }, ASSET, 7n);

beforeEach(() => {
  sent.length = 0;
});

describe('the one-token approval', () => {
  it('approves the protocol for the token and counts it only when it reads back', async () => {
    states = [at(WALLET, null), at(WALLET, DIAMOND)];
    await expect(make().approve(null)).resolves.toBeUndefined();
    expect(sent).toEqual([{ to: DIAMOND }]);
  });
  it('refuses before any prompt when the holder or the approval moved since the review', async () => {
    states = [at(OTHER, null)];
    await expect(make().approve(null)).rejects.toMatchObject({ refusal: { code: 'NftApprovalChanged' } });
    states = [at(WALLET, OTHER)];
    await expect(make().approve(null)).rejects.toMatchObject({ refusal: { code: 'NftApprovalChanged' } });
    expect(sent).toEqual([]);
  });
  it('states an approval that did not read back, whatever the receipt said', async () => {
    states = [at(WALLET, null), at(WALLET, null)];
    await expect(make().approve(null)).rejects.toMatchObject({ refusal: { code: 'NftApprovalNotSet' } });
  });
});

describe('putting the approval back', () => {
  it('needs nothing once the token has left the wallet (a transfer clears it)', async () => {
    states = [at(OTHER, null)];
    expect(await make().putBack(null)).toEqual({ ok: true, sentence: 'nftApproval.notHeld' });
    expect(sent).toEqual([]);
  });
  it('never overwrites an approval something else set since', async () => {
    states = [at(WALLET, OTHER)];
    expect(await make().putBack(null)).toEqual({ ok: false, sentence: 'nftApproval.restoreChanged' });
    expect(sent).toEqual([]);
  });
  it('restores the prior approval while it still reads the protocol, judged by the read back', async () => {
    states = [at(WALLET, DIAMOND), at(WALLET, null)];
    expect(await make().putBack(null)).toEqual({ ok: true, sentence: 'nftApproval.restored' });
    expect(sent).toEqual([{ to: '0x0000000000000000000000000000000000000000' }]);
    states = [at(WALLET, DIAMOND), at(WALLET, DIAMOND)];
    expect(await make().putBack(null)).toEqual({ ok: false, sentence: 'nftApproval.restoreNotLanded' });
  });
});
