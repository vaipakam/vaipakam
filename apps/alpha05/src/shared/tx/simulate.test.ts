import { ContractFunctionRevertedError, parseAbi, type PublicClient } from 'viem';
import { describe, expect, it } from 'vitest';
import type { OwnStateClient } from '../../chain/ownRail';
import { askThrough } from './simulate';

const abi = parseAbi(['function ownerOf(uint256) view returns (address)']);
const revert = () => new ContractFunctionRevertedError({ abi, functionName: 'ownerOf', message: 'ERC721NonexistentToken' });
const own = (n: number): OwnStateClient =>
  ({
    chainId: 84532,
    account: '0x0000000000000000000000000000000000000001',
    walletFirst: true,
    sources: Array.from({ length: n }, (_, i) => ({ via: i === 0 ? 'wallet' : 'proxy', client: { id: i } as unknown as PublicClient })),
    read: () => Promise.reject(new Error('unused')),
  }) as OwnStateClient;

describe('askThrough', () => {
  it('stops at a revert: the contract answered', async () => {
    let calls = 0;
    const r = await askThrough(own(2), async () => {
      calls += 1;
      throw revert();
    });
    expect(r.kind).toBe('reverted');
    expect(calls).toBe(1);
  });

  it('passes over a source that cannot run the call', async () => {
    const r = await askThrough(own(2), async (c) => {
      if ((c as unknown as { id: number }).id === 0) throw new Error('timeout');
      return 'answer';
    });
    expect(r).toEqual({ kind: 'answered', value: 'answer' });
  });

  it('is unreadable, never a negative answer, when no source can run it', async () => {
    const r = await askThrough(own(2), async () => {
      throw new Error('fetch failed\nmore detail');
    });
    expect(r).toEqual({ kind: 'unreadable', reason: 'fetch failed' });
  });
});
