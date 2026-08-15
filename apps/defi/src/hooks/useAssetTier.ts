import { useEffect, useState } from 'react';
import { useDiamondRead } from '../contracts/useDiamond';

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
  const valid = !!asset && ADDR_RE.test(asset);
  // The result is TAGGED with the asset it describes, and both `'unknown'`
  // (disabled) and `'loading'` (in flight) are DERIVED from it below rather
  // than stored. Storing them meant writing state from the effect body, which
  // paints the PREVIOUS asset's tier for one frame before correcting it — a
  // caller rendering "Tier 3 → up to 80% LTV" would flash the old asset's
  // allowance beside the new asset's name. Deriving closes that window in both
  // directions: a switch to an invalid asset, and a switch back to a valid one,
  // which the earlier shape left showing a stale tier until the fetch landed.
  const [result, setResult] = useState<{
    asset: string;
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
      setResult({ asset: asset as string, status: next });
    })();
    return () => {
      cancelled = true;
    };
  }, [valid, diamondRead, asset]);

  if (!valid) return 'unknown';
  return result?.asset === asset ? result.status : 'loading';
}
