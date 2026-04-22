import { useCallback, useEffect, useMemo, useState } from 'react';
import { Interface } from 'ethers';
import { useDiamondRead, useReadChain } from '../contracts/useDiamond';
import { DEFAULT_CHAIN } from '../contracts/config';
import { DIAMOND_ABI } from '../contracts/abis';
import { batchCalls, type BatchCall } from '../lib/multicall';
import { useLogIndex } from './useLogIndex';
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
  const diamond = useDiamondRead();
  const chain = useReadChain();
  const chainId = chain.chainId ?? DEFAULT_CHAIN.chainId;
  const diamondAddress = chain.diamondAddress ?? DEFAULT_CHAIN.diamondAddress;
  const { offerIds, loading: indexLoading, error: indexError } = useLogIndex();
  const [offers, setOffers] = useState<RecentOffer[]>(
    () => cache.get(cacheKey(chainId, diamondAddress, limit))?.data ?? [],
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(indexError ?? null);

  const iface = useMemo(() => new Interface(DIAMOND_ABI), []);

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
    if (recentIds.length === 0) {
      setOffers([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const step = beginStep({ area: 'dashboard', flow: 'useRecentOffers', step: 'multicall-offers' });
    try {
      const calls: BatchCall[] = recentIds.map((id) => ({
        target: diamondAddress,
        callData: iface.encodeFunctionData('getOffer', [id]),
      }));
      const decoded = await batchCalls<RawOffer>(
        (diamond as unknown as { runner: { provider: never } }).runner.provider as never,
        iface,
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
      step.success({ note: `${resolved.length} offers` });
    } catch (err) {
      setError(err as Error);
      step.failure(err);
    } finally {
      setLoading(false);
    }
  }, [diamond, iface, recentIds, limit, chainId, diamondAddress]);

  useEffect(() => {
    if (indexLoading) return;
    load();
  }, [load, indexLoading]);

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
