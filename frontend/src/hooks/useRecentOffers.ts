import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Address } from 'viem';
import { useDiamondPublicClient, useReadChain } from '../contracts/useDiamond';
import { DEFAULT_CHAIN } from '../contracts/config';
import { DIAMOND_ABI_VIEM as DIAMOND_ABI } from '../contracts/abis';
import { batchCalls, encodeBatchCalls } from '../lib/multicall';
import { useLogIndex } from './useLogIndex';
import { useLiveWatermark } from './useLiveWatermark';
import { watermarkPolicy } from './watermarkPolicy';
import {
  fetchRecentOffers,
  type IndexedOffer,
} from '../lib/indexerClient';
import { beginStep } from '../lib/journeyLog';

const STALE_MS = 30_000;

export interface RecentOffer {
  id: bigint;
  creator: string;
  offerType: number;
  lendingAsset: string;
  amount: bigint;
  interestRateBps: bigint;
  collateralAsset: string;
  collateralAmount: bigint;
  durationDays: bigint;
  principalLiquidity: number;
  collateralLiquidity: number;
  accepted: boolean;
  assetType: number;
  tokenId: bigint;
}

type RawOffer = {
  id: bigint;
  creator: string;
  offerType: bigint | number;
  lendingAsset: string;
  amount: bigint;
  interestRateBps: bigint;
  collateralAsset: string;
  collateralAmount: bigint;
  durationDays: bigint;
  principalLiquidity: bigint | number;
  collateralLiquidity: bigint | number;
  accepted: boolean;
  assetType: bigint | number;
  tokenId: bigint;
};

interface CacheEntry {
  data: RecentOffer[];
  at: number;
  limit: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(chainId: number, diamondAddress: string, limit: number): string {
  return `${chainId}:${diamondAddress.toLowerCase()}:${limit}`;
}

function toRecentOffer(r: RawOffer): RecentOffer {
  return {
    id: r.id,
    creator: r.creator,
    offerType: Number(r.offerType),
    lendingAsset: r.lendingAsset,
    amount: r.amount,
    interestRateBps: r.interestRateBps,
    collateralAsset: r.collateralAsset,
    collateralAmount: r.collateralAmount,
    durationDays: r.durationDays,
    principalLiquidity: Number(r.principalLiquidity),
    collateralLiquidity: Number(r.collateralLiquidity),
    accepted: r.accepted,
    assetType: Number(r.assetType),
    tokenId: r.tokenId,
  };
}

/** Indexer→RecentOffer adapter. Same shape as `toRecentOffer`, but
 *  reads off the indexer's IndexedOffer struct instead of the on-
 *  chain `getOffer` return tuple. The indexer carries every field
 *  RecentOffer needs already, so no chain reads. */
function indexedToRecentOffer(o: IndexedOffer): RecentOffer {
  return {
    id: BigInt(o.offerId),
    creator: o.creator,
    offerType: o.offerType,
    lendingAsset: o.lendingAsset,
    amount: BigInt(o.amount),
    interestRateBps: BigInt(o.interestRateBps),
    collateralAsset: o.collateralAsset,
    collateralAmount: BigInt(o.collateralAmount),
    durationDays: BigInt(o.durationDays),
    principalLiquidity: o.principalLiquidity,
    collateralLiquidity: o.collateralLiquidity,
    accepted: o.status === 'accepted',
    assetType: o.assetType,
    tokenId: BigInt(o.tokenId),
  };
}

/**
 * Fetches the latest `limit` offers (any state — open, accepted, cancelled)
 * for the advanced-mode Recent Activity list on the public dashboard. Uses
 * the event-backed offer index as the source of IDs, then a single multicall
 * on `getOffer` to resolve the payloads. Results are cached for STALE_MS to
 * amortize the cost across dashboard toggles.
 *
 * Spec: `docs/WebsiteReadme.md` recent-activity section requires the latest
 * ~50 loans AND offers in advanced mode.
 */
export function useRecentOffers(limit = 50) {
  const publicClient = useDiamondPublicClient();
  const chain = useReadChain();
  const chainId = chain.chainId ?? DEFAULT_CHAIN.chainId;
  const diamondAddress = (chain.diamondAddress ?? DEFAULT_CHAIN.diamondAddress) as Address;
  const { offerIds, loading: indexLoading, error: indexError } = useLogIndex();
  // Cool-tier auto-refresh: 180 s active, 600 s idle, pause @ 15 min.
  // Aggregate / dashboard surface — sub-minute refresh would be theatre.
  const { version: watermarkVersion } = useLiveWatermark(watermarkPolicy('cool'));
  const [offers, setOffers] = useState<RecentOffer[]>(
    () => cache.get(cacheKey(chainId, diamondAddress, limit))?.data ?? [],
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(indexError ?? null);

  const recentIds = useMemo(() => {
    return [...offerIds]
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
      .slice(0, limit);
  }, [offerIds, limit]);

  const load = useCallback(async () => {
    const key = cacheKey(chainId, diamondAddress, limit);
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < STALE_MS) {
      setOffers(cached.data);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);

    // Indexer-first path. The new `/offers/recent?limit=...` endpoint
    // returns the latest N IndexedOffer rows across every status, so
    // the multicall storm against the chain disappears on the happy
    // path. When the worker is unreachable (`fetchRecentOffers`
    // returns null), we fall through to the legacy log-scan +
    // multicall path below — which still gets the work done, just at
    // higher RPC cost.
    const step = beginStep({
      area: 'dashboard',
      flow: 'useRecentOffers',
      step: 'indexer-recent',
    });
    try {
      const page = await fetchRecentOffers(chainId, { limit });
      if (page) {
        const resolved = page.offers.map(indexedToRecentOffer);
        cache.set(key, { data: resolved, at: Date.now(), limit });
        setOffers(resolved);
        setLoading(false);
        step.success({ note: `${resolved.length} offers (indexer)` });
        return;
      }
    } catch {
      // Worker unreachable — fall through to chain reads below.
    }

    // Fallback: legacy log-scan + multicall (preserved exactly so a
    // worker outage doesn't blank the dashboard).
    if (recentIds.length === 0) {
      setOffers([]);
      setLoading(false);
      return;
    }
    const fallbackStep = beginStep({
      area: 'dashboard',
      flow: 'useRecentOffers',
      step: 'multicall-offers',
    });
    try {
      const calls = encodeBatchCalls(
        diamondAddress,
        DIAMOND_ABI,
        'getOffer',
        recentIds.map((id) => [id] as const),
      );
      const decoded = await batchCalls<RawOffer>(
        publicClient,
        DIAMOND_ABI,
        'getOffer',
        calls,
      );
      const resolved: RecentOffer[] = [];
      for (const raw of decoded) {
        if (!raw) continue;
        resolved.push(toRecentOffer(raw));
      }
      cache.set(key, { data: resolved, at: Date.now(), limit });
      setOffers(resolved);
      fallbackStep.success({ note: `${resolved.length} offers (chain fallback)` });
    } catch (err) {
      setError(err as Error);
      fallbackStep.failure(err);
    } finally {
      setLoading(false);
    }
  }, [publicClient, recentIds, limit, chainId, diamondAddress]);

  useEffect(() => {
    if (indexLoading) return;
    load();
    // `watermarkVersion` is in the dep list so cool-tier auto-
    // refresh reaches this hook. The hook's own 30 s stale cache
    // still amortises across versions where neither create-counter
    // moved between probes.
  }, [load, indexLoading, watermarkVersion]);

  return {
    offers,
    loading: loading || indexLoading,
    error: error ?? indexError,
    reload: load,
  };
}

/** Test-only: wipe the module-scoped cache. */
export function __clearRecentOffersCache() {
  cache.clear();
}
