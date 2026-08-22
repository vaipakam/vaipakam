/**
 * #1645 — the accept-preview vocabulary and the gate built on it.
 *
 * `scripts/check-accept-errors.mjs` already pins the mirror's member
 * NAMES to `OfferAcceptFacet.sol`. These tests cover what that script
 * cannot: that the numbers mean what the contract says they mean, that
 * every member has words, and that the gate's fail postures are the
 * ones the module documents rather than the ones that happen to fall
 * out of the code.
 */
import { describe, expect, it } from 'vitest';
import { BaseError, ContractFunctionRevertedError } from 'viem';
import {
  ACCEPT_ERROR_NAMES,
  ACCEPT_OK,
  acceptBlockReason,
  acceptErrorName,
} from './acceptErrors';
import { assertAcceptPreviewClearLive } from './preflights';
import { copy } from '../content/copy';

/** Selector of `VaipakamDiamond.FunctionDoesNotExist()`. */
const FN_MISSING = '0xa9ad62f8';

describe('the mirrored vocabulary', () => {
  it('places the codes this app reasons about where the contract does', () => {
    // Spot-pinned rather than exhaustive: the guard script compares the
    // whole list, so these exist to make a silent RE-NUMBERING of the
    // members the accept path added most recently fail loudly here too.
    expect(ACCEPT_ERROR_NAMES[ACCEPT_OK]).toBe('None');
    expect(ACCEPT_ERROR_NAMES[14]).toBe('SalePositionBelowSolvencyFloor');
    expect(ACCEPT_ERROR_NAMES[16]).toBe('SaleListingTermsStale');
    expect(ACCEPT_ERROR_NAMES[17]).toBe('ProtocolPaused');
    expect(ACCEPT_ERROR_NAMES[18]).toBe('VaultUpgradeRequired');
    expect(ACCEPT_ERROR_NAMES[19]).toBe('SelfTrade');
  });

  it('has words for every member, and only `None` clears', () => {
    expect(acceptBlockReason(ACCEPT_OK)).toBeNull();
    for (let code = 1; code < ACCEPT_ERROR_NAMES.length; code += 1) {
      const reason = acceptBlockReason(code);
      expect(reason, `${ACCEPT_ERROR_NAMES[code]} has no copy`).toBeTruthy();
      // Never fall through to the generic message for a member we know
      // about — that would be a silently worse answer than the contract
      // already gives.
      expect(reason).not.toBe(copy.errors.acceptBlocked.unknown);
    }
  });

  it('treats an unrecognised code as a refusal, never as an all-clear', () => {
    // The app can be older than the Diamond, and this enum grows by
    // appending. Reading an unknown code as "fine" is exactly the
    // walk-into-a-revert this gate exists to stop.
    expect(acceptBlockReason(ACCEPT_ERROR_NAMES.length)).toBe(
      copy.errors.acceptBlocked.unknown,
    );
    expect(acceptBlockReason(250)).toBe(copy.errors.acceptBlocked.unknown);
  });

  it('names codes for logs without pretending to know unknown ones', () => {
    expect(acceptErrorName(16)).toBe('SaleListingTermsStale');
    expect(acceptErrorName(250)).toBe('Unknown(250)');
  });
});

/** A publicClient stub whose single `readContract` behaviour is given. */
function clientReturning(errorCode: number) {
  return {
    readContract: async () => ({ errorCode }),
  } as never;
}
function clientThrowing(err: unknown) {
  return {
    readContract: async () => {
      throw err;
    },
  } as never;
}

/** A viem revert carrying `selector`, undecodable against our ABI —
 *  which is how an unrouted Diamond selector actually arrives. */
function undecodableRevert(selector: string) {
  const inner = new ContractFunctionRevertedError({
    abi: [],
    functionName: 'previewAccept',
  });
  inner.signature = selector as `0x${string}`;
  const outer = new BaseError('reverted');
  outer.walk = () => inner;
  return outer;
}

const GATE = {
  diamondAddress: '0x00000000000000000000000000000000000000d1' as const,
  offerId: 1n,
  acceptor: '0x00000000000000000000000000000000000000ac' as const,
};

describe('assertAcceptPreviewClearLive', () => {
  it('passes a clear preview', async () => {
    await expect(
      assertAcceptPreviewClearLive({
        publicClient: clientReturning(ACCEPT_OK),
        ...GATE,
      }),
    ).resolves.toBeUndefined();
  });

  it('blocks with the code’s own words, not a generic failure', async () => {
    await expect(
      assertAcceptPreviewClearLive({ publicClient: clientReturning(16), ...GATE }),
    ).rejects.toThrow(copy.errors.acceptBlocked.saleListingStale);
  });

  it('blocks an unrecognised code rather than letting it through', async () => {
    await expect(
      assertAcceptPreviewClearLive({ publicClient: clientReturning(250), ...GATE }),
    ).rejects.toThrow(copy.errors.acceptBlocked.unknown);
  });

  it('passes when the deploy simply has no such view', async () => {
    // An older Diamond answers an unrouted selector with
    // `FunctionDoesNotExist()`. Refusing there would block every accept
    // on a deploy that predates the preview — the contract still
    // enforces, so this is a missing check, not a failed one.
    await expect(
      assertAcceptPreviewClearLive({
        publicClient: clientThrowing(undecodableRevert(FN_MISSING)),
        ...GATE,
      }),
    ).resolves.toBeUndefined();
  });

  it('fails closed when the view itself reverts', async () => {
    // A different revert is NOT "no such function": we could not get a
    // verdict, and re-reading is free where a wasted signature is not.
    await expect(
      assertAcceptPreviewClearLive({
        publicClient: clientThrowing(undecodableRevert('0xdeadbeef')),
        ...GATE,
      }),
    ).rejects.toThrow(copy.errors.checkRetry);
  });

  it('fails closed on transport trouble', async () => {
    await expect(
      assertAcceptPreviewClearLive({
        publicClient: clientThrowing(new Error('socket hang up')),
        ...GATE,
      }),
    ).rejects.toThrow(copy.errors.checkRetry);
  });
});
