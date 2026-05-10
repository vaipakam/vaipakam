import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Address } from 'viem';
import { useDiamondRead, useReadChain } from '../contracts/useDiamond';
import { beginStep } from '../lib/journeyLog';

/**
 * Skinny ranking row returned by
 * `MetricsFacet.getActiveOffersByAssetPairRanked`. Holds only the
 * sort-relevant subset of the full Offer struct so the OfferBook can
 * sort/filter the entire pair bucket in JS without per-offer
 * hydration.
 *
 * The caller hydrates only the page-N slice it actually renders by
 * calling `getOffer(id)` (multicalled) for those ids.
 */
export interface OfferRanking {
  id: bigint;
  /** 0 = Lender, 1 = Borrower. Mirrors `LibVaipakam.OfferType`. */
  offerType: number;
  amount: bigint;
  amountMax: bigint;
  interestRateBps: bigint;
  interestRateBpsMax: bigint;
  durationDays: bigint;
  createdAt: bigint;
}

export interface UseActiveOffersByAssetPairRankedResult {
  rankings: OfferRanking[];
  total: bigint;
  loading: boolean;
  error: Error | null;
  /** Force a re-fetch (e.g. after an OfferCreated/Accepted/Cancelled
   *  event fires for the current pair). Bypasses the staleness cache. */
  refresh: () => Promise<void>;
}

const STALE_MS = 30_000;

interface CacheEntry {
  rankings: OfferRanking[];
  total: bigint;
  at: number;
}
const cache = new Map<string, CacheEntry>();
/**
 * Cache key MUST include chainId. Without it, a user switching from
 * arb-sepolia (rankings cached for USDC/WETH) to base-sepolia hits the
 * same (lending, collateral) bucket and gets served arb-sepolia's
 * rankings until they click the explicit refresh button. The user
 * surfaced this on 2026-05-11 — "after chain change, only the refresh
 * button reloads offers/loans". Same bug class repeated across the
 * dashboard hooks; see the matching fixes in useDashboard*.ts.
 */
const keyOf = (chainId: number, lending: string, collateral: string) =>
  `${chainId}:${lending.toLowerCase()}:${collateral.toLowerCase()}`;

/**
 * Reads the entire active-offer bucket for a (lending, collateral)
 * pair as skinny ranking rows in one round trip. Pairs with the
 * frontend's per-id `getOffer` multicall to hydrate only the page
 * slice the user is looking at.
 *
 * Caching: per-pair, 30 s staleness. The OfferBook subscribes to
 * `OfferCreated` / `OfferAccepted` / `OfferCanceled` events for the
 * current pair and calls `refresh()` to invalidate proactively when
 * one of them lands within the window.
 *
 * Null inputs return an empty result without firing the call — used
 * to gate the hook on chains where ChainConfig defaults aren't
 * populated yet.
 */
export function useActiveOffersByAssetPairRanked(
  lendingAsset: Address | null,
  collateralAsset: Address | null,
): UseActiveOffersByAssetPairRankedResult {
  const diamond = useDiamondRead();
  const chain = useReadChain();
  const cacheKey =
    lendingAsset && collateralAsset
      ? keyOf(chain.chainId, lendingAsset, collateralAsset)
      : '';

  const [rankings, setRankings] = useState<OfferRanking[]>(() =>
    cacheKey ? (cache.get(cacheKey)?.rankings ?? []) : [],
  );
  const [total, setTotal] = useState<bigint>(() =>
    cacheKey ? (cache.get(cacheKey)?.total ?? 0n) : 0n,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(
    async (force: boolean = false) => {
      if (!lendingAsset || !collateralAsset) {
        setRankings([]);
        setTotal(0n);
        setLoading(false);
        return;
      }
      // Short-circuit when the chain has no Diamond deployed (or the
      // wallet hasn't connected to a chain yet). `useDiamondRead()`
      // falls back to ZERO_ADDRESS when chain.diamondAddress is null
      // (useDiamond.ts:251); firing getActiveOffersByAssetPairRanked
      // against 0x000…000 throws AbiDecodingZeroDataError every render
      // and pollutes the diagnostics drawer. Diagnostics-drawer error
      // surfaced 2026-05-10 with chainId 421614 + wallet:not-connected.
      if (!chain.diamondAddress) {
        setRankings([]);
        setTotal(0n);
        setLoading(false);
        setError(null);
        return;
      }
      if (!force) {
        const cached = cache.get(cacheKey);
        if (cached && Date.now() - cached.at < STALE_MS) {
          setRankings(cached.rankings);
          setTotal(cached.total);
          setLoading(false);
          return;
        }
      }
      setLoading(true);
      setError(null);
      const step = beginStep({
        area: 'offer-book',
        flow: 'useActiveOffersByAssetPairRanked',
        step: `${lendingAsset}/${collateralAsset}`,
      });
      try {
        const raw = await (
          diamond as unknown as {
            getActiveOffersByAssetPairRanked: (
              lending: Address,
              collateral: Address,
            ) => Promise<[readonly OfferRanking[], bigint]>;
          }
        ).getActiveOffersByAssetPairRanked(lendingAsset, collateralAsset);
        const rows = raw[0];
        const totalReturned = raw[1];
        // Defensive copy so the cached entry isn't mutated by JS sort
        // calls in the consumer.
        const copy = rows.map((r) => ({ ...r }));
        cache.set(cacheKey, {
          rankings: copy,
          total: totalReturned,
          at: Date.now(),
        });
        setRankings(copy);
        setTotal(totalReturned);
        step.success({ note: `${copy.length} ranked` });
      } catch (err) {
        setError(err as Error);
        step.failure(err);
      } finally {
        setLoading(false);
      }
    },
    [diamond, lendingAsset, collateralAsset, cacheKey, chain.diamondAddress],
  );

  useEffect(() => {
    load(false);
  }, [load]);

  const refresh = useCallback(async () => {
    if (cacheKey) cache.delete(cacheKey);
    await load(true);
  }, [load, cacheKey]);

  return useMemo(
    () => ({ rankings, total, loading, error, refresh }),
    [rankings, total, loading, error, refresh],
  );
}

/** Test-only — wipes the per-pair cache so a fresh fetch fires. */
export function __clearActiveOffersByAssetPairRankedCache() {
  cache.clear();
}
