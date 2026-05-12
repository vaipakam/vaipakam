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
  const [status, setStatus] = useState<AssetLiquidityStatus>(
    valid ? 'loading' : 'unknown',
  );

  useEffect(() => {
    if (!valid) {
      setStatus('unknown');
      return;
    }
    let cancelled = false;
    setStatus('loading');
    (async () => {
      try {
        // `checkLiquidity(address) → uint8` — enum LiquidityStatus:
        // 0 = Liquid, 1 = Illiquid (fail-closed).
        const res = await diamondRead.checkLiquidity(asset);
        if (cancelled) return;
        setStatus(Number(res) === 0 ? 'liquid' : 'illiquid');
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
