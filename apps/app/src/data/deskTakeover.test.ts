import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import { readTakeoverOfferIds } from './desk';
import type { IndexedOffer } from './indexer';

const DIAMOND = '0x0000000000000000000000000000000000000d1a' as const;
const row = (offerId: number, offerType: number) => ({ offerId, offerType }) as unknown as IndexedOffer;

function client(read: (offerId: bigint) => Promise<bigint>): PublicClient {
  return { readContract: ({ args }: { args: [bigint] }) => read(args[0]) } as unknown as PublicClient;
}

describe('readTakeoverOfferIds (#3845)', () => {
  it('names the borrower rows posted for one loan, and probes only borrower rows', async () => {
    const asked: bigint[] = [];
    const ids = await readTakeoverOfferIds(
      client(async (id) => {
        asked.push(id);
        return id === 2n ? 7n : 0n;
      }),
      DIAMOND,
      [row(1, 0), row(2, 1), row(3, 1)],
    );
    expect([...ids]).toEqual([2]);
    expect(asked).toEqual([2n, 3n]);
  });

  it('rejects when any read fails, so an unread row is never quoted as demand', async () => {
    await expect(
      readTakeoverOfferIds(
        client(async (id) => {
          if (id === 3n) throw new Error('dropped');
          return 0n;
        }),
        DIAMOND,
        [row(2, 1), row(3, 1)],
      ),
    ).rejects.toThrow('dropped');
  });
});
