import { useCallback, useEffect, useState } from 'react';
import type { Address } from 'viem';
import { useDiamondRead, useReadChain } from '../contracts/useDiamond';
import { beginStep } from '../lib/journeyLog';

const STALE_MS = 30_000;
const DEFAULT_LIMIT = 20;

/**
 * Page of `LibVaipakam.Offer` rows the connected user created.
 * Backed by `MetricsDashboardFacet.getUserDashboardOffers`.
 *
 * AnalyticalGettersDesign §3.1 / D4 — split by `filledOnly`:
 *   - `filledOnly=false` → currently-open (un-accepted) offers
 *   - `filledOnly=true`  → accepted/filled offers (lifetime walk)
 *
 * Both paths share the cache namespace; cache key includes the
 * boolean so the two surfaces don't trample each other.
 */
export type DashboardOffer = Record<string, unknown>;

interface CacheKey {
  chainId: number;
  user: string;
  filledOnly: boolean;
  offset: number;
  limit: number;
}
const cache = new Map<string, { data: DashboardOffer[]; at: number }>();
// Cache key prefixed with chainId so a switch from arb-sepolia to
// base-sepolia doesn't serve the prior chain's rows from cache.
// 2026-05-11 user report: "after chain change, only the refresh
// button reloads offers/loans" — fixed by chain-prefixing every
// dashboard hook's cache key.
const keyOf = (k: CacheKey) =>
  `${k.chainId}:${k.user}:${k.filledOnly ? 'filled' : 'open'}:${k.offset}:${k.limit}`;

export function useDashboardOffers(
  user: Address | null,
  filledOnly: boolean,
  offset: number = 0,
  limit: number = DEFAULT_LIMIT,
) {
  const diamond = useDiamondRead();
  const chain = useReadChain();
  const cacheKey = user
    ? keyOf({ chainId: chain.chainId, user: user.toLowerCase(), filledOnly, offset, limit })
    : '';
  const [rows, setRows] = useState<DashboardOffer[]>(
    cache.get(cacheKey)?.data ?? [],
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(async () => {
    if (!user) {
      setRows([]);
      setLoading(false);
      return;
    }
    // Short-circuit when the chain has no Diamond (useDiamondRead
    // falls back to ZERO_ADDRESS). See useActiveOffersByAssetPairRanked
    // for the same fix + the 2026-05-10 diagnostics-drawer report
    // that surfaced this bug class.
    if (!chain.diamondAddress) {
      setRows([]);
      setLoading(false);
      setError(null);
      return;
    }
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.at < STALE_MS) {
      setRows(cached.data);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const step = beginStep({
      area: 'dashboard',
      flow: 'useDashboardOffers',
      step: `${filledOnly ? 'filled' : 'open'} off=${offset} lim=${limit}`,
    });
    try {
      const raw = await (
        diamond as unknown as {
          getUserDashboardOffers: (
            u: Address,
            f: boolean,
            off: number,
            lim: number,
          ) => Promise<DashboardOffer[]>;
        }
      ).getUserDashboardOffers(user, filledOnly, offset, limit);
      cache.set(cacheKey, { data: raw, at: Date.now() });
      setRows(raw);
      step.success({ note: `${raw.length} rows` });
    } catch (err) {
      setError(err as Error);
      step.failure(err);
    } finally {
      setLoading(false);
    }
  }, [diamond, user, filledOnly, offset, limit, cacheKey, chain.diamondAddress]);

  useEffect(() => {
    load();
  }, [load]);

  const reload = useCallback(async () => {
    cache.delete(cacheKey);
    await load();
  }, [load, cacheKey]);

  return { rows, loading, error, reload };
}

/** Test-only — wipes the per-page cache. */
export function __clearDashboardOffersCache() {
  cache.clear();
}
