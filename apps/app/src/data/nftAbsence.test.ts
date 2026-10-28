import { describe, expect, it, vi } from 'vitest';
import type { PublicClient } from 'viem';
import { classifyAbsence, readNftAbsence } from './nftAbsence';

const DIAMOND = '0x00000000000000000000000000000000000000d1' as const;

const clientReturning = (impl: () => Promise<unknown>) => {
  const readContract = vi.fn(impl);
  return { client: { readContract } as unknown as PublicClient, readContract };
};

describe('classifyAbsence', () => {
  it('calls an id at or below the highest ever allocated retired', () => {
    expect(classifyAbsence(1n, 5n)).toBe('retired');
    expect(classifyAbsence(5n, 5n)).toBe('retired');
  });

  it('calls an id above it never minted', () => {
    expect(classifyAbsence(6n, 5n)).toBe('never-minted');
  });

  it('calls every id never minted before the first allocation', () => {
    expect(classifyAbsence(1n, 0n)).toBe('never-minted');
  });
});

describe('readNftAbsence', () => {
  it('reads the view at the block that established the absence', async () => {
    const { client, readContract } = clientReturning(async () => 9n);
    expect(await readNftAbsence(client, DIAMOND, 3n, 1234n)).toBe('retired');
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'highestTokenId', blockNumber: 1234n }),
    );
  });

  it('says the deployment cannot tell when the view is not served', async () => {
    const { client } = clientReturning(async () => {
      throw new Error('execution reverted: FunctionDoesNotExist()');
    });
    expect(await readNftAbsence(client, DIAMOND, 3n, 1n)).toBe('unrecorded');
  });

  it('says it could not check when the read fails for any other reason', async () => {
    const { client } = clientReturning(async () => {
      throw new Error('fetch failed');
    });
    expect(await readNftAbsence(client, DIAMOND, 3n, 1n)).toBe('unchecked');
  });
});
