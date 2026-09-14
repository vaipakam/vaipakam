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

  // THE CASE THE CASES ABOVE STRUCTURALLY CANNOT MAKE (#2190 r11
  // `4009116588`). They all build their errors from the `viem` THIS file
  // imports — the same physical module `contractRevert.ts` imports — so an
  // `instanceof` implementation passes every one of them while being broken
  // for every real caller. The bug was exactly that: pnpm resolves `viem`
  // per peer context, `apps/app` and `packages/lib` land on two different
  // copies, and a `BaseError` from the app's client is not an instance of
  // this package's `BaseError`.
  //
  // So this case reaches for the APP's copy deliberately. If the two ever
  // hoist to one physical module the assertion still holds — it just stops
  // being the interesting test, which is why the paths are asserted rather
  // than assumed: a silent collapse to one copy would otherwise look like
  // continued coverage.
  it('is true for a revert thrown by ANOTHER package’s copy of viem', async () => {
    const { createRequire } = await import('node:module');
    const req = createRequire(new URL('../../../apps/app/package.json', import.meta.url));
    const appViemPath = req.resolve('viem');
    const appViem = req(appViemPath) as typeof import('viem');

    const ownPath = createRequire(import.meta.url).resolve('viem');
    if (appViemPath !== ownPath) {
      // The condition that made the original bug possible, pinned so the
      // test's value is visible rather than incidental.
      expect(appViem.BaseError).not.toBe(BaseError);
    }

    const e = new appViem.BaseError('reverted', {
      cause: new appViem.ContractFunctionRevertedError({
        abi: [],
        functionName: 'ownerOf',
        message: 'ERC721: invalid token ID',
      }),
    });
    expect(isRevert(e)).toBe(true);

    // And the asymmetry survives the crossing too: a transport failure from
    // the other copy must still read as unknown, not as a burn.
    expect(isRevert(new appViem.BaseError('HTTP request failed'))).toBe(false);
  });
});
