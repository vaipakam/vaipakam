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
  const [status, setStatus] = useState<AssetTierStatus>(valid ? 'loading' : 'unknown');

  useEffect(() => {
    if (!valid) {
      setStatus('unknown');
      return;
    }
    let cancelled = false;
    setStatus('loading');
    (async () => {
      try {
        // `getEffectiveLiquidityTier(address) → uint8` — fail-closed to 0
        // (asset(0), not Liquid, etc.); never reverts.
        const res = await diamondRead.getEffectiveLiquidityTier(asset);
        if (cancelled) return;
        const n = Number(res);
        if (n === 0 || n === 1 || n === 2 || n === 3) {
          setStatus(n as 0 | 1 | 2 | 3);
        } else {
          setStatus('unknown');
        }
      } catch {
        if (cancelled) return;
        setStatus('unknown');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [valid, diamondRead, asset]);

  return status;
}
