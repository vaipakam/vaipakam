import { ContractFunctionRevertedError, parseAbi } from 'viem';
import { describe, expect, it } from 'vitest';
import { probeCall, probeTransfer, type ProbeInput } from './transferProbe';

const asset = ('0x' + '1'.repeat(40)) as `0x${string}`;
const holder = ('0x' + 'a'.repeat(40)) as `0x${string}`;
const diamond = ('0x' + 'd'.repeat(40)) as `0x${string}`;
const vault = ('0x' + 'e'.repeat(40)) as `0x${string}`;
const ZERO = ('0x' + '0'.repeat(40)) as `0x${string}`;

const input = (over: Partial<ProbeInput> = {}): ProbeInput => ({
  asset,
  standard: 'erc721',
  tokenId: 7n,
  quantity: 1n,
  holder,
  diamond,
  vault,
  protocolMayMove: false,
  blockNumber: 99n,
  ...over,
});

describe('#3433 the test move of a pledged NFT', () => {
  it('moves an ERC-721 as the protocol once it may, else as the holder, to the vault, at the read block', () => {
    const asHolder = probeCall(input())!;
    expect(asHolder.by).toBe('holder');
    expect(asHolder.account).toBe(holder);
    expect(asHolder.call).toMatchObject({ functionName: 'transferFrom', args: [holder, vault, 7n], blockNumber: 99n });
    const asProtocol = probeCall(input({ protocolMayMove: true }))!;
    expect(asProtocol.by).toBe('protocol');
    expect(asProtocol.account).toBe(diamond);
  });

  it('moves an ERC-721 to the protocol when the post opens the vault; an ERC-1155 is asked only into a vault, as the protocol', () => {
    expect(probeCall(input({ vault: ZERO }))!.to).toBe(diamond);
    expect(probeCall(input({ standard: 'erc1155', vault: ZERO, protocolMayMove: true }))).toBeNull();
    // The vault's receive hook refuses a holder's own delivery, so before the approval nothing is asked.
    expect(probeCall(input({ standard: 'erc1155', quantity: 3n }))).toBeNull();
    const asProtocol = probeCall(input({ standard: 'erc1155', quantity: 3n, protocolMayMove: true }))!;
    expect(asProtocol.account).toBe(diamond);
    expect(asProtocol.call).toMatchObject({ functionName: 'safeTransferFrom', args: [holder, vault, 7n, 3n, '0x'] });
  });

  it('reads a refusal as the token’s answer and an outage as unread', async () => {
    const source = (simulateContract: () => Promise<unknown>) => ({ sources: [{ client: { simulateContract } }] }) as never;
    const revert = new ContractFunctionRevertedError({ abi: parseAbi(['function transferFrom(address,address,uint256)']), functionName: 'transferFrom', message: 'soulbound' });
    const refused = await probeTransfer(source(async () => Promise.reject(revert)), input());
    expect(refused.kind).toBe('refused');
    expect(await probeTransfer(source(async () => ({ result: undefined })), input())).toEqual({ kind: 'moves', by: 'holder', blockNumber: 99n });
    expect((await probeTransfer(source(async () => Promise.reject(new Error('fetch failed'))), input())).kind).toBe('unread');
  });
});
