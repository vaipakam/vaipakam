import { useEffect, useState } from 'react';
import { useDiamondRead } from '../contracts/useDiamond';

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

export type AssetLiquidityStatus = 'liquid' | 'illiquid' | 'loading' | 'unknown';

/**
 * Live read of `OracleFacet.checkLiquidity(asset)` on the current
 * read-chain — the same per-chain gate the contract applies at
 * loan-init / accept. `checkLiquidity` returns `Liquid` only when the
 * asset has a fresh Chainlink feed AND a deep-enough on-chain V3 pool
 * *on this chain*; an asset can be deep on one chain and thin on
 * another (its liquidity may live on its home chain), so this read is
 * chain-scoped.
 *
 * UX-only — used to surface the "thin liquidity on this chain" warning
 * on Create Offer / Accept Offer. The on-chain gate (and, at
 * liquidation, the aggregator-routed swap) is the actual enforcement.
 *
 * Returns `'unknown'` when the chain has no Diamond, the asset isn't a
 * valid address, or the read errors. Pass `null` to disable (e.g. for
 * NFT collateral, where "illiquid" is expected and the cross-chain
 * warning doesn't apply).
 */
export function useAssetLiquidity(
  asset: string | null | undefined,
): AssetLiquidityStatus {
  const diamondRead = useDiamondRead();
  const valid = !!asset && ADDR_RE.test(asset);
  // Result TAGGED with the asset it describes; `'unknown'` (disabled) and
  // `'loading'` (in flight) are DERIVED. See `useAssetTier` for the reasoning
  // — this hook has the same shape and the same one-frame stale window.
  const [result, setResult] = useState<{
    asset: string;
    status: 'liquid' | 'illiquid' | 'unknown';
  } | null>(null);

  useEffect(() => {
    if (!valid) return;
    let cancelled = false;
    (async () => {
      // `checkLiquidity(address) → uint8` — enum LiquidityStatus:
      // 0 = Liquid, 1 = Illiquid (fail-closed).
      let next: 'liquid' | 'illiquid' | 'unknown';
      try {
        next = Number(await diamondRead.checkLiquidity(asset)) === 0 ? 'liquid' : 'illiquid';
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
