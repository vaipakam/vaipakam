import { useCallback, useEffect, useState } from 'react';
import type { Address } from 'viem';
import { useDiamondRead } from '../contracts/useDiamond';
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
  user: string;
  filledOnly: boolean;
  offset: number;
  limit: number;
}
const cache = new Map<string, { data: DashboardOffer[]; at: number }>();
const keyOf = (k: CacheKey) =>
  `${k.user}:${k.filledOnly ? 'filled' : 'open'}:${k.offset}:${k.limit}`;

export function useDashboardOffers(
  user: Address | null,
  filledOnly: boolean,
  offset: number = 0,
  limit: number = DEFAULT_LIMIT,
) {
  const diamond = useDiamondRead();
  const cacheKey = user
    ? keyOf({ user: user.toLowerCase(), filledOnly, offset, limit })
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
  }, [diamond, user, filledOnly, offset, limit, cacheKey]);

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
