import { useEffect, useState } from 'react';
import { useReadyDiamond, useReadChain } from '../contracts/useDiamond';

/**
 * #886 Codex P3 — is the auto-lend / lender-intent facet set cut on the current
 * chain's Diamond?
 *
 * `isLenderIntentEnabled()` is a view on that facet, so it RESOLVES (whatever
 * the enabled flag returns) when the facet is routed, and REVERTS with the
 * Diamond's `FunctionDoesNotExist` (selector `0xa9ad62f8`) when it isn't. We
 * only need the cut-or-not signal, not the enabled flag itself.
 *
 * The missing-facet-vs-transient discrimination mirrors
 * {@link AutoLendIntentCard}'s own account-read catch (an old-deploy revert →
 * not cut; any other error → unknown), so the page's unavailable state and the
 * card's self-hide always agree on the same chains.
 *
 * Returns:
 *   - `true`  — facet cut; the feature is reachable and the card renders its
 *               own enabled/disabled state.
 *   - `false` — facet not cut on this chain; the caller should show an explicit
 *               unavailable note instead of "create an intent below" copy.
 *   - `null`  — unknown (loading, no ready diamond, or a transient read error).
 *               The caller must NOT show the unavailable state on `null`, so a
 *               one-off RPC blip never hides an otherwise-working page.
 */
export function useAutoLendFacetAvailable(): boolean | null {
  const diamondRo = useReadyDiamond();
  const chain = useReadChain();
  const [available, setAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    setAvailable(null);
    if (!diamondRo) return;
    void (async () => {
      try {
        await (
          diamondRo as unknown as {
            isLenderIntentEnabled: () => Promise<boolean>;
          }
        ).isLenderIntentEnabled();
        if (!cancelled) setAvailable(true);
      } catch (e) {
        const msg = String(
          (e as { data?: string; message?: string })?.data ??
            (e as Error)?.message ??
            '',
        );
        const missingFacet =
          msg.includes('0xa9ad62f8') ||
          /function does not exist|functionnotfound/i.test(msg);
        if (!cancelled) setAvailable(missingFacet ? false : null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [diamondRo, chain.chainId]);

  return available;
}
