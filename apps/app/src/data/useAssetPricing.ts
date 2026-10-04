/**
 * #2384 — one batched read of the pricing facts the Offer Book's LTV line
 * needs, for the assets on the visible page. Pure planning and mapping
 * live in `offerLtv.ts` (tested there); this is only the wiring.
 *
 * Tri-state like every read in the app: `undefined` while loading, `null`
 * when the whole batch failed (each card then says its LTV couldn't be
 * checked), otherwise a map from lower-cased asset to its facts. A failed
 * refetch drops a cached answer rather than serving it — a price that
 * failed to refresh is an unknown, not the last thing the app heard.
 */
import { useQuery } from '@tanstack/react-query';
import { erc20Abi } from 'viem';
import { usePublicClient } from 'wagmi';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { useActiveChain } from '../chain/useActiveChain';
import { LIQUIDITY_LIQUID } from '../contracts/preflights';
import { freshData } from '../lib/freshData';
import { idleAware } from '../lib/idle';
import { pricingFacts, pricingPlan, type AssetPricing } from './offerLtv';

/** Oracle prices move; a minute keeps a card's ratio current without a
 *  read per render. */
const REFRESH_MS = 60_000;

export function useAssetPricing(
  assets: readonly string[],
): ReadonlyMap<string, AssetPricing> | null | undefined {
  const { readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  const unique = [...new Set(assets.map((a) => a.toLowerCase()))].sort();
  const q = useQuery({
    queryKey: ['assetPricing', readChain.chainId, unique],
    enabled: unique.length > 0 && publicClient !== undefined,
    staleTime: REFRESH_MS,
    refetchInterval: idleAware(REFRESH_MS),
    queryFn: async () => {
      const plan = pricingPlan(readChain.diamondAddress, unique, {
        diamond: DIAMOND_ABI_VIEM,
        erc20: erc20Abi,
      });
      try {
        const slots = await publicClient!.multicall({
          allowFailure: true,
          contracts: plan.flatMap((p) => p.contracts) as never,
        });
        return pricingFacts(plan, slots as never, LIQUIDITY_LIQUID);
      } catch {
        return null;
      }
    },
  });
  if (unique.length === 0) return new Map();
  return freshData(q);
}
