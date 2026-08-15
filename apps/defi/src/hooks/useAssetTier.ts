import { useEffect, useState } from 'react';
import { useDiamondRead, useReadChain } from '../contracts/useDiamond';

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Depth-tiered-LTV effective tier for one asset. `0` = illiquid /
 * untierable (no borrow against it under the depth-tier regime); `1`..`3`
 * = the highest tier the asset clears, *capped by the keeper's
 * confidence floor*. The contract reads it as
 * `min(getLiquidityTier(asset), keeperTier(asset))` so a brand-new
 * asset opens at Tier 1 (today's `HF ≥ 1.5` baseline) until the
 * off-chain confidence relay promotes it, and a compromised keeper can
 * only ever lower a tier — never raise it above the on-chain ceiling.
 *
 * `'unknown'` when the chain has no Diamond, the asset isn't a valid
 * address, or the read errors. Pass `null` to disable (e.g. for NFT
 * collateral, where the tier concept doesn't apply). `'loading'` while
 * the read is in flight.
 *
 * UX-only — the binding loan-init gate enforces the tier cap on-chain.
 * Use this to render "this asset is Tier N → up to X% LTV" hints on
 * Create Offer / the OfferBook widget, or to gate the LTV input range.
 */
export type AssetTierStatus = 0 | 1 | 2 | 3 | 'loading' | 'unknown';

export function useAssetTier(
  asset: string | null | undefined,
): AssetTierStatus {
  const diamondRead = useDiamondRead();
  const chainId = useReadChain().chainId;
  const valid = !!asset && ADDR_RE.test(asset);
  // The request key is the WHOLE identity of the read, not just the asset.
  // Tagging by asset alone was the same half-measure this PR set out to
  // remove: switching chains with the address unchanged kept serving the
  // previous chain's tier — and a tier drives an LTV cap, so the wrong one is
  // not a cosmetic staleness.
  const reqKey = valid ? `${chainId}|${(asset as string).toLowerCase()}` : null;
  // The result is TAGGED with the asset it describes, and both `'unknown'`
  // (disabled) and `'loading'` (in flight) are DERIVED from it below rather
  // than stored. Storing them meant writing state from the effect body, which
  // paints the PREVIOUS asset's tier for one frame before correcting it — a
  // caller rendering "Tier 3 → up to 80% LTV" would flash the old asset's
  // allowance beside the new asset's name. Deriving closes that window in both
  // directions: a switch to an invalid asset, and a switch back to a valid one,
  // which the earlier shape left showing a stale tier until the fetch landed.
  const [result, setResult] = useState<{
    key: string;
    status: 0 | 1 | 2 | 3 | 'unknown';
  } | null>(null);

  useEffect(() => {
    if (!valid) return;
    let cancelled = false;
    (async () => {
      // `getEffectiveLiquidityTier(address) → uint8` — fail-closed to 0
      // (asset(0), not Liquid, etc.); never reverts.
      let next: 0 | 1 | 2 | 3 | 'unknown';
      try {
        const n = Number(await diamondRead.getEffectiveLiquidityTier(asset));
        next = n === 0 || n === 1 || n === 2 || n === 3 ? (n as 0 | 1 | 2 | 3) : 'unknown';
      } catch {
        next = 'unknown';
      }
      if (cancelled) return;
      setResult({ key: reqKey as string, status: next });
    })();
    return () => {
      cancelled = true;
      // Drop the answer on the way OUT, so a re-enable cannot reuse it. The
      // key alone cannot catch that case: disabling and re-enabling the SAME
      // address rebuilds an identical key, and the stale result would match it
      // — which is reachable from Create Offer by toggling collateral type
      // away from ERC-20 and back, and would hand the submit gate a liquidity
      // reading taken before the toggle.
      setResult(null);
    };
  }, [valid, diamondRead, reqKey, asset]);

  if (!valid) return 'unknown';
  return result?.key === reqKey ? result.status : 'loading';
}
