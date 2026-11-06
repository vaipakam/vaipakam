import { describe, expect, it, vi } from 'vitest';
import { BaseError, ContractFunctionRevertedError, encodeAbiParameters, encodeEventTopics, parseAbi, type Log, type PublicClient } from 'viem';
import { diamondMayMove, holds, MAX_1155_QUANTITY, NFT_ABI, parseQuantity, parseTokenId, quantityMoved, readErc1155, readErc721, readStandard, tokenMoved } from './nft';

type Hex = `0x${string}`;
const ASSET: Hex = '0x1111111111111111111111111111111111111111';
const WALLET: Hex = '0x2222222222222222222222222222222222222222';
const DIAMOND: Hex = '0x3333333333333333333333333333333333333333';
const VAULT: Hex = '0x4444444444444444444444444444444444444444';

/** A viem-shaped revert: the contract's own answer, not a failed read. */
const revert = (functionName: string) => new BaseError('reverted', { cause: new ContractFunctionRevertedError({ abi: NFT_ABI, functionName }) });

function client(answers: Record<string, (args: readonly unknown[]) => unknown>): PublicClient {
  return {
    getBlockNumber: vi.fn(async () => 10n),
    readContract: vi.fn(async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      const f = answers[functionName];
      if (!f) throw new Error(`unexpected ${functionName}`);
      return f(args ?? []);
    }),
  } as unknown as PublicClient;
}

describe('the standard a collection claims (ERC-165)', () => {
  it('reads ERC-721 and ERC-1155 from the contract, and a contract without ERC-165 as a token', async () => {
    expect(await readStandard(client({ supportsInterface: ([id]) => id === '0x80ac58cd' }), ASSET)).toBe('erc721');
    expect(await readStandard(client({ supportsInterface: ([id]) => id === '0xd9b67a26' }), ASSET)).toBe('erc1155');
    expect(
      await readStandard(
        client({
          supportsInterface: () => {
            throw revert('supportsInterface');
          },
        }),
        ASSET,
      ),
    ).toBe('erc20');
  });
  it('lets a failed read through rather than calling the asset a token', async () => {
    await expect(
      readStandard(
        client({
          supportsInterface: () => {
            throw new Error('rpc down');
          },
        }),
        ASSET,
      ),
    ).rejects.toThrow('rpc down');
  });
});

describe('a token as the wallet and the protocol stand on it', () => {
  it('reads the holder and both approvals at one block', async () => {
    const c = client({ ownerOf: () => WALLET, getApproved: () => DIAMOND, isApprovedForAll: () => false });
    const s = await readErc721(c, ASSET, 7n, WALLET, DIAMOND);
    expect(s).toEqual({ owner: WALLET, approved: DIAMOND, approvedForAll: false, blockNumber: 10n });
    expect(holds(s, WALLET)).toBe(true);
    expect(diamondMayMove(s, DIAMOND)).toBe(true);
    for (const call of (c.readContract as ReturnType<typeof vi.fn>).mock.calls) expect(call[0].blockNumber).toBe(10n);
  });
  it('reads a token that does not exist as no holder, and a failed read as a failure', async () => {
    const missing = await readErc721(
      client({
        ownerOf: () => {
          throw revert('ownerOf');
        },
      }),
      ASSET,
      7n,
      WALLET,
      DIAMOND,
      5n,
    );
    expect(missing).toEqual({ owner: null, approved: null, approvedForAll: false, blockNumber: 5n });
    await expect(
      readErc721(
        client({
          ownerOf: () => {
            throw new Error('rpc down');
          },
        }),
        ASSET,
        7n,
        WALLET,
        DIAMOND,
      ),
    ).rejects.toThrow('rpc down');
  });
  it('lets the protocol move a token under a collection approval too', () => {
    expect(diamondMayMove({ owner: WALLET, approved: null, approvedForAll: true, blockNumber: 1n }, DIAMOND)).toBe(true);
    expect(diamondMayMove({ owner: WALLET, approved: VAULT, approvedForAll: false, blockNumber: 1n }, DIAMOND)).toBe(false);
  });
});

describe('a token id as typed', () => {
  it('takes whole digits only, within the chain range', () => {
    expect(parseTokenId(' 42 ')).toBe(42n);
    expect(parseTokenId('0')).toBe(0n);
    expect(parseTokenId('4.2')).toBeNull();
    expect(parseTokenId('-1')).toBeNull();
    expect(parseTokenId('')).toBeNull();
    expect(parseTokenId((2n ** 256n).toString())).toBeNull();
  });
});

describe("the token's move, from the transaction's own logs", () => {
  const abi = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)']);
  const log = (address: Hex, from: Hex, to: Hex, tokenId: bigint): Log =>
    ({ address, topics: encodeEventTopics({ abi, eventName: 'Transfer', args: { from, to, tokenId } }), data: '0x' }) as unknown as Log;
  it('finds the exact token moving from the wallet to the vault', () => {
    expect(tokenMoved([log(ASSET, WALLET, VAULT, 7n)], ASSET, 7n, WALLET, VAULT)).toBe(true);
    expect(tokenMoved([log(ASSET, WALLET, VAULT, 8n)], ASSET, 7n, WALLET, VAULT)).toBe(false);
    expect(tokenMoved([log(DIAMOND, WALLET, VAULT, 7n)], ASSET, 7n, WALLET, VAULT)).toBe(false);
    expect(tokenMoved([log(ASSET, WALLET, DIAMOND, 7n)], ASSET, 7n, WALLET, VAULT)).toBe(false);
  });
  it('never reads an ERC-20 transfer (three topics) as the token', () => {
    const erc20 = { address: ASSET, topics: encodeEventTopics({ abi, eventName: 'Transfer', args: { from: WALLET, to: VAULT } }), data: '0x07' } as unknown as Log;
    expect(tokenMoved([erc20], ASSET, 7n, WALLET, VAULT)).toBe(false);
  });
});

describe('an ERC-1155 token as the wallet and the protocol stand on it', () => {
  it('reads the balance and the operator approval at one fresh block', async () => {
    const c = client({ balanceOf: ([who, id]) => (who === WALLET && id === 7n ? 5n : 0n), isApprovedForAll: ([, op]) => op === DIAMOND });
    expect(await readErc1155(c, ASSET, 7n, WALLET, DIAMOND)).toEqual({ balance: 5n, approvedForAll: true, blockNumber: 10n });
    expect(c.getBlockNumber).toHaveBeenCalledWith({ cacheTime: 0 });
    for (const call of (c.readContract as ReturnType<typeof vi.fn>).mock.calls) expect(call[0].blockNumber).toBe(10n);
  });
  it('reads at the block it is given', async () => {
    const c = client({ balanceOf: () => 1n, isApprovedForAll: () => false });
    expect((await readErc1155(c, ASSET, 7n, WALLET, DIAMOND, 20n)).blockNumber).toBe(20n);
    expect(c.getBlockNumber).not.toHaveBeenCalled();
  });
});

describe('a quantity as typed', () => {
  it('takes whole digits from one up to what the vault records', () => {
    expect(parseQuantity(' 3 ')).toBe(3n);
    expect(parseQuantity('0')).toBeNull();
    expect(parseQuantity('1.5')).toBeNull();
    expect(parseQuantity('-2')).toBeNull();
    expect(parseQuantity('')).toBeNull();
    expect(parseQuantity(MAX_1155_QUANTITY.toString())).toBe(MAX_1155_QUANTITY);
    expect(parseQuantity((MAX_1155_QUANTITY + 1n).toString())).toBeNull();
  });
});

describe("an ERC-1155 quantity's move, from the transaction's own logs", () => {
  const abi = parseAbi([
    'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
    'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)',
  ]);
  const single = (address: Hex, from: Hex, to: Hex, id: bigint, value: bigint): Log =>
    ({
      address,
      topics: encodeEventTopics({ abi, eventName: 'TransferSingle', args: { operator: DIAMOND, from, to } }),
      data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [id, value]),
    }) as unknown as Log;
  const batch = (from: Hex, to: Hex, ids: bigint[], values: bigint[]): Log =>
    ({
      address: ASSET,
      topics: encodeEventTopics({ abi, eventName: 'TransferBatch', args: { operator: DIAMOND, from, to } }),
      data: encodeAbiParameters([{ type: 'uint256[]' }, { type: 'uint256[]' }], [ids, values]),
    }) as unknown as Log;
  it('sums the token moving from the wallet to the vault, single and batch together', () => {
    const logs = [single(ASSET, WALLET, VAULT, 7n, 2n), batch(WALLET, VAULT, [7n, 8n], [3n, 9n])];
    expect(quantityMoved(logs, ASSET, 7n, WALLET, VAULT)).toBe(5n);
  });
  it('ignores another token, another collection, another destination and an ERC-721 transfer', () => {
    const t721 = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)']);
    const logs = [
      single(ASSET, WALLET, VAULT, 8n, 2n),
      single(DIAMOND, WALLET, VAULT, 7n, 2n),
      single(ASSET, WALLET, DIAMOND, 7n, 2n),
      { address: ASSET, topics: encodeEventTopics({ abi: t721, eventName: 'Transfer', args: { from: WALLET, to: VAULT, tokenId: 7n } }), data: '0x' } as unknown as Log,
    ];
    expect(quantityMoved(logs, ASSET, 7n, WALLET, VAULT)).toBe(0n);
  });
});
