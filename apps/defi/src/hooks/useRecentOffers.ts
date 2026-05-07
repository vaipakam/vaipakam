import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Address } from 'viem';
import { useDiamondPublicClient, useReadChain } from '../contracts/useDiamond';
import { DEFAULT_CHAIN } from '../contracts/config';
import { DIAMOND_ABI_VIEM as DIAMOND_ABI } from '@vaipakam/contracts/abis';
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
 * Defensive sanity check on an offer's headline values. Returns
 * true for an offer that's safe to render in the Analytics recent
 * feed; false for one whose fields are obviously malformed.
 *
 * Why: testnet has a tail of legacy offers indexed against a
 * previous Diamond deploy whose storage slots returned garbage —
 * 18-decimal amounts on the order of 1e30+, interest rates of
 * 10⁹ bps (10 million percent APR), durations in the 1e18-day
 * range. Rendering them produces visually broken rows like
 * `546,341,515,459,535,421,382,276,466,788.3682  10,000,000.00%
 *  10000000000000000000d` which makes the page look broken.
 *
 * Thresholds are intentionally generous so legitimate edge cases
 * pass:
 *
 *   - amount     ≤ 1e36 — covers an 18-decimal token at $1e18
 *                         token-units (1 quintillion tokens), well
 *                         beyond any realistic offer
 *   - rateBps    ≤ 100_000 — 1000% APR; on-chain MAX_INTEREST_BPS
 *                         caps at 10_000 (100%) but we leave 10×
 *                         headroom for forward-compat
 *   - duration   ≤ 36_500 days — 100 years
 *   - asset must be a valid 42-char address (catches the `"0x"`
 *     short-shape garbage too)
 */
function isOfferShapeSane(o: RecentOffer): boolean {
  const MAX_AMOUNT = BigInt('1' + '0'.repeat(36));
  const MAX_RATE_BPS = 100_000n;
  const MAX_DURATION_DAYS = 36_500n;
  if (
    typeof o.lendingAsset !== 'string' ||
    o.lendingAsset.length !== 42 ||
    !o.lendingAsset.startsWith('0x')
  ) {
    return false;
  }
  if (o.amount > MAX_AMOUNT) return false;
  if (o.interestRateBps > MAX_RATE_BPS) return false;
  if (o.durationDays > MAX_DURATION_DAYS) return false;
  return true;
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
        // Defensive shape filter — drops legacy testnet rows whose
        // amount / rate / duration / asset fields are obvious
        // garbage from a stale storage slot. See `isOfferShapeSane`
        // for thresholds + rationale.
        const mapped = page.offers.map(indexedToRecentOffer);
        const resolved = mapped.filter(isOfferShapeSane);
        cache.set(key, { data: resolved, at: Date.now(), limit });
        setOffers(resolved);
        setLoading(false);
        step.success({
          note: `${resolved.length} offers (indexer; ${
            mapped.length - resolved.length
          } dropped as malformed)`,
        });
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
      let droppedCount = 0;
      for (const raw of decoded) {
        if (!raw) continue;
        const shaped = toRecentOffer(raw);
        if (!isOfferShapeSane(shaped)) {
          droppedCount += 1;
          continue;
        }
        resolved.push(shaped);
      }
      cache.set(key, { data: resolved, at: Date.now(), limit });
      setOffers(resolved);
      fallbackStep.success({
        note: `${resolved.length} offers (chain fallback; ${droppedCount} dropped as malformed)`,
      });
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
