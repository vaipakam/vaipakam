/**
 * Revert vs never-answered (#2190 r6).
 *
 * Two surfaces decide real behaviour on this: the Claim Center prunes a
 * side whose `ownerOf` reverts, and the indexer's #2101 repair clears that
 * side's stored holder. Both must treat a transport failure as UNKNOWN
 * instead — clearing a live holder on a blip hides a real claim, which is
 * the opposite harm to the one the burned case causes.
 */
import { describe, expect, it } from 'vitest';
import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
} from 'viem';
import { isRevert } from './contractRevert';

describe('isRevert', () => {
  it('is true for a contract revert — the chain answered "no"', () => {
    const e = new BaseError('reverted', {
      cause: new ContractFunctionRevertedError({
        abi: [],
        functionName: 'ownerOf',
        message: 'ERC721: invalid token ID',
      }),
    });
    expect(isRevert(e)).toBe(true);
  });

  it('is true for empty data — the same authoritative "no"', () => {
    const e = new BaseError('zero data', {
      cause: new ContractFunctionZeroDataError({ functionName: 'ownerOf' }),
    });
    expect(isRevert(e)).toBe(true);
  });

  it('is FALSE for a transport failure — nothing was established', () => {
    // The direction that matters: a timeout must never read as "burned",
    // or a blip clears a live holder and hides their claim.
    expect(isRevert(new Error('fetch failed'))).toBe(false);
    expect(isRevert(new BaseError('HTTP request failed'))).toBe(false);
  });

  it('is FALSE for anything that is not an error at all', () => {
    for (const v of [null, undefined, 'reverted', 42, {}]) {
      expect(isRevert(v)).toBe(false);
    }
  });
});
