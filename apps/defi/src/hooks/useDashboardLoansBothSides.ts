import { useCallback, useEffect, useState } from 'react';
import type { Address } from 'viem';
import { useDiamondRead, useReadChain } from '../contracts/useDiamond';
import { beginStep } from '../lib/journeyLog';

const STALE_MS = 30_000;
const DEFAULT_LIMIT = 20;

/**
 * Unified-table page of every active loan the user participates
 * in — lender side AND borrower side merged into one stream, each
 * row tagged `borrowerSide` so the role-chip filter can render
 * client-side without a second fetch.
 *
 * Backed by `MetricsDashboardFacet.getUserDashboardLoansBothSides`.
 *
 * AnalyticalGettersDesign §3.1 / D3 — preferred over the
 * per-side {useDashboardLoans} when the surface renders a
 * unified table (e.g. Dashboard.tsx). The per-side hook stays
 * available for surfaces that genuinely paginate one side at a
 * time.
 */
export interface LoanWithRiskAndSide {
  loan: Record<string, unknown>;
  ltvBps: bigint;
  healthFactor: bigint;
  borrowerSide: boolean;
}

interface CacheKey {
  chainId: number;
  user: string;
  offset: number;
  limit: number;
}
const cache = new Map<string, { data: LoanWithRiskAndSide[]; at: number }>();
// Cache key chain-prefixed — see useDashboardOffers.ts for the
// 2026-05-11 chain-switch-stale-data fix.
const keyOf = (k: CacheKey) => `${k.chainId}:${k.user}:${k.offset}:${k.limit}`;

export function useDashboardLoansBothSides(
  user: Address | null,
  offset: number = 0,
  limit: number = DEFAULT_LIMIT,
) {
  const diamond = useDiamondRead();
  const chain = useReadChain();
  const cacheKey = user
    ? keyOf({ chainId: chain.chainId, user: user.toLowerCase(), offset, limit })
    : '';
  const [rows, setRows] = useState<LoanWithRiskAndSide[]>(
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
      flow: 'useDashboardLoansBothSides',
      step: `unified off=${offset} lim=${limit}`,
    });
    try {
      const raw = await (
        diamond as unknown as {
          getUserDashboardLoansBothSides: (
            u: Address,
            off: number,
            lim: number,
          ) => Promise<LoanWithRiskAndSide[]>;
        }
      ).getUserDashboardLoansBothSides(user, offset, limit);
      cache.set(cacheKey, { data: raw, at: Date.now() });
      setRows(raw);
      step.success({
        note: `${raw.length} rows (lender ${
          raw.filter((r) => !r.borrowerSide).length
        } / borrower ${raw.filter((r) => r.borrowerSide).length})`,
      });
    } catch (err) {
      setError(err as Error);
      step.failure(err);
    } finally {
      setLoading(false);
    }
  }, [diamond, user, offset, limit, cacheKey]);

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
export function __clearDashboardLoansBothSidesCache() {
  cache.clear();
}
