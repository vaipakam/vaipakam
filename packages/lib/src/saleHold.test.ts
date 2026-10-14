/**
 * The shared sale-hold probe (#2483). The app's own suite pins the
 * classifier and the lock-first read order through its re-export; these pin
 * what moving the probe into this package changed: errors are read
 * structurally, and a revert it cannot name is an answer, not a throw.
 */
import { describe, expect, it } from 'vitest';
import { BaseError } from 'viem';
import {
  LOCK_EARLY_WITHDRAWAL_SALE,
  probeErrorName,
  probeSaleHoldLive,
  saleHoldBlocksSettlement,
} from './saleHold';

const DIAMOND = '0x00000000000000000000000000000000000000d1' as const;

/** A revert shaped the way viem reports one, built without viem's class so
 *  the probe's structural read is what is exercised. */
function revert(errorName?: string): Error {
  const inner = {
    name: 'ContractFunctionRevertedError',
    data: errorName ? { errorName } : undefined,
  };
  const err = new Error('reverted') as Error & { walk: (fn: (x: unknown) => boolean) => unknown };
  err.walk = (fn) => (fn(inner) ? inner : null);
  return err;
}

function lockedClient(simulate: () => never) {
  return {
    readContract: async () => BigInt(LOCK_EARLY_WITHDRAWAL_SALE),
    simulateContract: async () => simulate(),
  } as never;
}

describe('probeSaleHoldLive', () => {
  it('a revert it cannot name is unknown — an answer the caller refuses on', async () => {
    await expect(
      probeSaleHoldLive(lockedClient(() => { throw revert(); }), DIAMOND, 1, 7n, undefined),
    ).resolves.toBe('unknown');
    await expect(
      probeSaleHoldLive(lockedClient(() => { throw revert('EnforcedPause'); }), DIAMOND, 1, 7n, undefined),
    ).resolves.toBe('unknown');
  });

  it('a transport failure throws, so the caller decides how to fail closed', async () => {
    await expect(
      probeSaleHoldLive(lockedClient(() => { throw new Error('fetch failed'); }), DIAMOND, 1, 7n, undefined),
    ).rejects.toThrow('fetch failed');
  });

  it('accepts a bigint token id, as the keeper reads it from the loan', async () => {
    await expect(
      probeSaleHoldLive(
        lockedClient(() => { throw revert('NoStaleSaleListing'); }),
        DIAMOND,
        1n,
        7n,
        undefined,
      ),
    ).resolves.toBe('accepted');
  });
});

describe('probeErrorName', () => {
  it('reads the name structurally and ignores what is not a revert', () => {
    expect(probeErrorName(revert('SaleListingLoanStillLive'))).toBe('SaleListingLoanStillLive');
    expect(probeErrorName(new BaseError('opaque'))).toBeNull();
    expect(probeErrorName(new Error('rpc timeout'))).toBeNull();
    expect(probeErrorName(undefined)).toBeNull();
  });
});

describe('saleHoldBlocksSettlement', () => {
  it('blocks on an accepted sale and on an unestablished state, and nothing else', () => {
    expect(saleHoldBlocksSettlement('accepted')).toBe(true);
    expect(saleHoldBlocksSettlement('unknown')).toBe(true);
    expect(saleHoldBlocksSettlement('none')).toBe(false);
    expect(saleHoldBlocksSettlement('live')).toBe(false);
    expect(saleHoldBlocksSettlement('clearable')).toBe(false);
  });
});
