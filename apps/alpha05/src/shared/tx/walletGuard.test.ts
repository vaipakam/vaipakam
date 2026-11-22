import { beforeEach, describe, expect, it, vi } from 'vitest';

const wallet = vi.hoisted(() => ({ account: { status: 'connected', address: '0x00000000000000000000000000000000000000aa', chainId: 84532 } as Record<string, unknown>, code: undefined as string | undefined }));
const calls = vi.hoisted(() => ({
  signTypedData: vi.fn(async () => '0xsig'),
  signMessage: vi.fn(async () => '0xsig'),
  writeContract: vi.fn(async () => '0xhash'),
  readContract: vi.fn(async () => '0x1626ba7e'),
}));
vi.mock('wagmi/actions', () => ({
  getAccount: vi.fn(() => wallet.account),
  signTypedData: calls.signTypedData,
  signMessage: calls.signMessage,
  writeContract: calls.writeContract,
  readContract: calls.readContract,
  getPublicClient: vi.fn(() => ({ getCode: async () => wallet.code })),
  getConnectorClient: vi.fn(async () => {
    throw new Error('no estimate');
  }),
}));

const { signMessage, signTypedData, writeContract, readContract } = calls;
import { sendWrite } from './send';
import { AccountWithoutCode } from './accountWallet';
import { liveIdentity, sendReviewed, signMessageFor, signTypedDataFor, WalletMoved } from './walletGuard';

const A = '0x00000000000000000000000000000000000000aa' as const;
const B = '0x00000000000000000000000000000000000000bb' as const;
const config = { getClient: () => ({}) } as never;

beforeEach(() => {
  vi.clearAllMocks();
  wallet.account = { status: 'connected', address: A, chainId: 84532 };
  wallet.code = undefined;
});

describe('#3770: an account wallet must be a contract on the network in use', () => {
  const safeWallet = () => ({ status: 'connected', address: A, chainId: 84532, connector: { id: 'safe' } });
  it('refuses a signature, with no prompt, when the Safe has no code here', async () => {
    wallet.account = safeWallet();
    await expect(signTypedDataFor(config, 84532, { account: A } as never)).rejects.toBeInstanceOf(AccountWithoutCode);
    expect(signTypedData).not.toHaveBeenCalled();
  });
  it('treats a 7702 delegation as a key wallet, not a contract', async () => {
    wallet.account = safeWallet();
    wallet.code = '0xef0100' + '11'.repeat(20);
    await expect(signMessageFor(config, 84532, { account: A, message: 'm' })).rejects.toBeInstanceOf(AccountWithoutCode);
    expect(signMessage).not.toHaveBeenCalled();
  });
  it('signs when the Safe has code here; a key wallet is never read', async () => {
    wallet.account = safeWallet();
    wallet.code = '0x6080';
    await signMessageFor(config, 84532, { account: A, message: 'm' });
    expect(signMessage).toHaveBeenCalledOnce();
  });
  it('waits for a Safe proposal to be signed before returning, and never for a key wallet', async () => {
    wallet.account = safeWallet();
    wallet.code = '0x6080';
    signMessage.mockResolvedValueOnce('0x');
    // The Safe answers that the message is signed on chain: EIP-1271 checks
    // it with an empty signature.
    await expect(signMessageFor(config, 84532, { account: A, message: 'm' })).resolves.toBe('0x');
    expect(readContract).toHaveBeenCalledOnce();
    wallet.account = { status: 'connected', address: A, chainId: 84532 };
    await expect(signMessageFor(config, 84532, { account: A, message: 'm' })).resolves.toBe('0xsig');
    expect(readContract).toHaveBeenCalledOnce();
  });
  it('a failed precheck stops the send before the record and the prompt', async () => {
    const save = vi.fn();
    const send = vi.fn(async () => '0xhash' as const);
    const hash = await sendReviewed({
      frozen: { identity: `84532:${A}` },
      liveIdentity: () => liveIdentity(config),
      apply: () => {},
      save,
      send,
      precheck: async () => {
        throw new AccountWithoutCode(84532);
      },
      failure: () => 'x',
    });
    expect(hash).toBeNull();
    expect(save).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('#1691: nothing for a wallet or network other than the reviewed one', () => {
  it('reads the live wallet, not the page', () => {
    expect(liveIdentity(config)).toBe(`84532:${A}`);
    wallet.account = { status: 'disconnected' };
    expect(liveIdentity(config)).toBeNull();
  });

  it('account switched between review and sign: no prompt, nothing saved', async () => {
    const frozen = { identity: `84532:${A}` };
    wallet.account = { status: 'connected', address: B, chainId: 84532 };
    const events: string[] = [];
    const save = vi.fn();
    const send = vi.fn(async () => '0xhash' as const);
    const hash = await sendReviewed({
      frozen,
      liveIdentity: () => liveIdentity(config),
      apply: (e) => events.push(e.type),
      save,
      send,
      failure: (e) => (e instanceof WalletMoved ? 'moved' : 'other'),
    });
    expect(hash).toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(events).toEqual(['sign', 'failed']);
  });

  it('the same wallet and network: the flow is saved, then sent', async () => {
    const save = vi.fn();
    const send = vi.fn(async () => '0xhash' as const);
    const hash = await sendReviewed({ frozen: { identity: `84532:${A.toUpperCase().replace('0X', '0x')}` }, liveIdentity: () => liveIdentity(config), apply: () => {}, save, send, failure: () => 'x' });
    expect(hash).toBe('0xhash');
    expect(save).toHaveBeenCalledOnce();
  });

  it('a network switch mid-flow stops the next write and signature before the wallet is asked', async () => {
    wallet.account = { status: 'connected', address: A, chainId: 1 };
    await expect(sendWrite(config, { address: A, abi: [], functionName: 'x', account: A, chainId: 84532 } as never)).rejects.toBeInstanceOf(WalletMoved);
    await expect(signTypedDataFor(config, 84532, { account: A } as never)).rejects.toBeInstanceOf(WalletMoved);
    await expect(signMessageFor(config, 84532, { account: A, message: 'm' })).rejects.toBeInstanceOf(WalletMoved);
    expect(writeContract).not.toHaveBeenCalled();
    expect(signTypedData).not.toHaveBeenCalled();
    expect(signMessage).not.toHaveBeenCalled();
  });
});
