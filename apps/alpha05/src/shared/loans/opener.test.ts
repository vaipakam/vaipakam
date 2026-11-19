import { describe, expect, it } from 'vitest';
import { parseLoanOpener, positionMoved, readLoanOpener } from './opener';
import type { IndexerClient } from '../reads/world/indexerClient';

const A = '0x00000000000000000000000000000000000000aa' as const;
const B = '0x00000000000000000000000000000000000000bb' as const;

describe('loan opener', () => {
  it('reads the borrower the indexer recorded, on the asked network', async () => {
    const paths: string[] = [];
    const ix: IndexerClient = {
      origin: 'https://ix',
      getJson: async <T,>(p: string) => {
        paths.push(p);
        return { borrower: A } as T;
      },
    };
    await expect(readLoanOpener(ix, 84532, 7n)).resolves.toBe(A);
    expect(paths).toEqual(['/loans/7?chainId=84532']);
  });

  it('refuses an answer with no address, so it reads as unknown', () => {
    expect(() => parseLoanOpener({})).toThrow();
    expect(() => parseLoanOpener({ borrower: '0x12' })).toThrow();
    expect(() => parseLoanOpener(null)).toThrow();
  });

  it('a move is unknown when either side is unknown, never "not moved"', () => {
    expect(positionMoved(null, A)).toBeNull();
    expect(positionMoved(A, null)).toBeNull();
    expect(positionMoved(A, A.toUpperCase().replace('0X', '0x') as `0x${string}`)).toBe(false);
    expect(positionMoved(A, B)).toBe(true);
  });
});
