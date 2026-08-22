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
import i18n from 'i18next';
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
/** What the loupe reports for a selector no facet hosts. */
const ZERO = '0x0000000000000000000000000000000000000000';

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

  it('serves the ACTIVE language, not the one loaded at import', async () => {
    // The failure this pins (Codex #1900 r1): the copy table used to
    // hold resolved STRINGS built at module scope. `reactiveCopy.ts`
    // calls that "the unsafe pattern (freezes the import-time
    // language)" — the app's module graph loads before the i18n
    // bootstrap finishes, so all twenty messages stayed English and
    // every translated bundle was dead weight. Holding catalog KEYS
    // and reading the leaf inside `acceptBlockReason` is what makes
    // the bundles reachable, and only a language switch proves it.
    if (!i18n.isInitialized) {
      await i18n.init({ lng: 'en', fallbackLng: 'en', resources: { en: { translation: {} } } });
    }
    const englishStale = acceptBlockReason(16);
    const englishSelfTrade = acceptBlockReason(19);
    i18n.addResourceBundle('es', 'translation', {
      copy: { errors: { acceptBlocked: { saleListingStale: 'ESPAÑOL' } } },
    });
    try {
      await i18n.changeLanguage('es');
      expect(acceptBlockReason(16)).toBe('ESPAÑOL');
      // A key this bundle lacks falls back to the English source, not
      // to a raw key path.
      expect(acceptBlockReason(19)).toBe(englishSelfTrade);
    } finally {
      await i18n.changeLanguage('en');
    }
    expect(acceptBlockReason(16)).toBe(englishStale);
  });
});

/** A publicClient stub that dispatches on the function being read, so
 *  the preview call and the loupe confirmation can answer differently —
 *  which is the whole point of the unrouted-vs-broken distinction. */
function client(opts: {
  preview?: () => unknown;
  /** What `facetAddress(previewAccept)` reports. Omitted → the loupe
   *  itself fails, which must not read as "unrouted". */
  facetAddress?: string;
}) {
  return {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'facetAddress') {
        if (opts.facetAddress === undefined) throw new Error('loupe unavailable');
        return opts.facetAddress;
      }
      if (!opts.preview) throw new Error('unexpected read');
      return opts.preview();
    },
  } as never;
}

function clientReturning(errorCode: number) {
  return client({ preview: () => ({ errorCode }) });
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

  it('passes when the deploy genuinely has no such view', async () => {
    // An older Diamond answers an unrouted selector with
    // `FunctionDoesNotExist()`, and the loupe agrees nothing hosts it.
    // Refusing there would block every accept on a deploy that predates
    // the preview — the contract still enforces, so this is a missing
    // check, not a failed one.
    await expect(
      assertAcceptPreviewClearLive({
        publicClient: client({
          preview: () => {
            throw undecodableRevert(FN_MISSING);
          },
          facetAddress: ZERO,
        }),
        ...GATE,
      }),
    ).resolves.toBeUndefined();
  });

  it('fails closed when a NESTED dependency is the missing one', async () => {
    // The same `FunctionDoesNotExist()` selector arrives when
    // `previewAccept` IS routed but something it calls through the
    // Diamond is not. Inferring "old deploy" from the error alone would
    // wave through a preview that is broken rather than absent — on
    // precisely the deployment where the accept hits the same missing
    // dependency. The loupe naming a host is what separates the two.
    await expect(
      assertAcceptPreviewClearLive({
        publicClient: client({
          preview: () => {
            throw undecodableRevert(FN_MISSING);
          },
          facetAddress: '0x00000000000000000000000000000000000000fa',
        }),
        ...GATE,
      }),
    ).rejects.toThrow(copy.errors.checkRetry);
  });

  it('fails closed when the loupe itself cannot answer', async () => {
    // Not knowing whether the selector is routed is not evidence that
    // it is absent.
    await expect(
      assertAcceptPreviewClearLive({
        publicClient: client({
          preview: () => {
            throw undecodableRevert(FN_MISSING);
          },
        }),
        ...GATE,
      }),
    ).rejects.toThrow(copy.errors.checkRetry);
  });

  it('fails closed when the view itself reverts', async () => {
    // A different revert is NOT "no such function": we could not get a
    // verdict, and re-reading is free where a wasted signature is not.
    // The loupe is not even consulted here.
    await expect(
      assertAcceptPreviewClearLive({
        publicClient: client({
          preview: () => {
            throw undecodableRevert('0xdeadbeef');
          },
          facetAddress: ZERO,
        }),
        ...GATE,
      }),
    ).rejects.toThrow(copy.errors.checkRetry);
  });

  it('fails closed on transport trouble', async () => {
    await expect(
      assertAcceptPreviewClearLive({
        publicClient: client({
          preview: () => {
            throw new Error('socket hang up');
          },
          facetAddress: ZERO,
        }),
        ...GATE,
      }),
    ).rejects.toThrow(copy.errors.checkRetry);
  });
});
