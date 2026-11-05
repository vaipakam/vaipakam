import type { PublicClient } from 'viem';
import { describe, expect, it } from 'vitest';
import type { OwnStateSource } from '../../chain/ownRail';
import { anchoredReader } from './anchored';

const sources: OwnStateSource[] = [
  { via: 'wallet', client: { id: 0 } as unknown as PublicClient },
  { via: 'proxy', client: { id: 1 } as unknown as PublicClient },
];
const id = (c: PublicClient) => (c as unknown as { id: number }).id;

describe('anchoredReader', () => {
  it('pins every read to the receipt block and passes over a source behind it', async () => {
    const seen: bigint[] = [];
    const at = anchoredReader(sources, 42n);
    const value = await at.read(async (c, b) => {
      seen.push(b.blockNumber);
      if (id(c) === 0) throw new Error('header not found');
      return 'from proxy';
    });
    expect(value).toBe('from proxy');
    expect(seen).toEqual([42n, 42n]);
  });

  it('is unreadable, never an answer, when no source can serve the block', async () => {
    const at = anchoredReader(sources, 42n);
    const r = await at.ask(async () => {
      throw new Error('header not found');
    });
    expect(r.kind).toBe('unreadable');
  });
});
