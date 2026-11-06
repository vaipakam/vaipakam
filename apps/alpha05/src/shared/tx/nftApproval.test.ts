import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from 'wagmi';
import type { OwnStateClient } from '../../chain/ownRail';
import type { Erc721State } from '../nft/nft';

type Hex = `0x${string}`;
const ASSET: Hex = '0x1111111111111111111111111111111111111111';
const WALLET: Hex = '0x2222222222222222222222222222222222222222';
const DIAMOND: Hex = '0x3333333333333333333333333333333333333333';
const NO_ADDRESS_HEX: Hex = '0x0000000000000000000000000000000000000000';
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
const { readErc721 } = await import('../nft/nft');

const at = (owner: Hex | null, approved: Hex | null): Erc721State => ({ owner, approved, approvedForAll: false, blockNumber: 1n });
/** A client whose head is block 15, behind the approval's receipt (block 20). */
const client = { getBlockNumber: vi.fn(async () => 15n) };
const own = { account: WALLET, read: async <T>(fn: (c: never) => Promise<T>) => ({ value: await fn(client as never), via: 'wallet' }) } as unknown as OwnStateClient;
const copy = { text: (k: string) => k, format: (k: string) => k } as never;
const make = () => nftApproval({ own, config: {} as Config, chainId: 1, diamond: DIAMOND, copy, tokenName: 'T #7', setStep: () => {} }, ASSET, 7n);

beforeEach(() => {
  sent.length = 0;
});

describe('the one-token approval', () => {
  it('approves the protocol for the token and counts it only when it reads back', async () => {
    states = [at(WALLET, null), at(WALLET, DIAMOND)];
    await expect(make().approve(null)).resolves.toBe(20n);
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

describe('an approval whose read-back fails', () => {
  it('is stated as unverified with its transaction, never as not landed', async () => {
    let calls = 0;
    const flaky = {
      account: WALLET,
      read: async <T>(fn: (c: never) => Promise<T>) => {
        if (++calls > 1) throw new Error('rpc down');
        return { value: await fn(client as never), via: 'wallet' };
      },
    } as unknown as OwnStateClient;
    states = [at(WALLET, null)];
    const ap = nftApproval({ own: flaky, config: {} as Config, chainId: 1, diamond: DIAMOND, copy, tokenName: 'T #7', setStep: () => {} }, ASSET, 7n);
    await expect(ap.approve(null)).rejects.toMatchObject({ refusal: { code: 'NftApprovalUnverified', reason: 'nftApproval.unread' } });
  });
});

describe('putting the approval back', () => {
  it('needs nothing once the token has left the wallet (a transfer clears it)', async () => {
    states = [at(OTHER, null)];
    expect(await make().putBack(null, 1n)).toEqual({ ok: true, sentence: 'nftApproval.notHeld' });
    expect(sent).toEqual([]);
  });
  it('never overwrites an approval something else set since', async () => {
    states = [at(WALLET, OTHER)];
    expect(await make().putBack(null, 1n)).toEqual({ ok: false, sentence: 'nftApproval.restoreChanged' });
    expect(sent).toEqual([]);
  });
  it('restores the prior approval while it still reads the protocol, judged by the read back', async () => {
    states = [at(WALLET, DIAMOND), at(WALLET, null)];
    expect(await make().putBack(null, 1n)).toEqual({ ok: true, sentence: 'nftApproval.restored' });
    expect(sent).toEqual([{ to: '0x0000000000000000000000000000000000000000' }]);
    states = [at(WALLET, DIAMOND), at(WALLET, DIAMOND)];
    expect(await make().putBack(null, 1n)).toEqual({ ok: false, sentence: 'nftApproval.restoreNotLanded' });
  });
});

describe('reads after the approval mined', () => {
  it('never read the token at a block before the approval, even from a fresh helper, so put-back cannot mistake it for restored', async () => {
    states = [at(WALLET, null), at(WALLET, DIAMOND)];
    const since = await make().approve(null);
    // The unwind builds its own helper; the approval's block travels with it.
    states = [at(WALLET, DIAMOND), at(WALLET, null)];
    vi.mocked(readErc721).mockClear();
    await make().putBack(null, since);
    // The head reads 15, the approval mined at 20: the put-back reads at 20.
    expect(vi.mocked(readErc721).mock.calls[0]![5]).toBe(20n);
    expect(client.getBlockNumber).toHaveBeenCalledWith({ cacheTime: 0 });
    expect(sent).toEqual([{ to: DIAMOND }, { to: NO_ADDRESS_HEX }]);
  });
});
