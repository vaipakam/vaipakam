import { useCallback, useEffect, useState } from 'react';
import type { Address } from 'viem';
import { useDiamondRead } from '../contracts/useDiamond';
import { beginStep } from '../lib/journeyLog';

const STALE_MS = 30_000;
const DEFAULT_LIMIT = 20;

/**
 * Page of {loan, ltvBps, healthFactor} rows for the connected user
 * — backed by `MetricsDashboardFacet.getUserDashboardLoans`.
 *
 * AnalyticalGettersDesign §3.1 / D2 — pagination cap 100 enforced
 * server-side; the frontend defaults to 20 per page so the
 * Dashboard's first paint is fast on mobile RPCs.
 *
 * D3 — separate calls for lender vs borrower side; pass
 * `borrowerSide={true|false}` per the panel.
 */
export interface LoanWithRisk {
  loan: Record<string, unknown>;
  ltvBps: bigint;
  healthFactor: bigint;
}

interface CacheKey {
  user: string;
  borrowerSide: boolean;
  offset: number;
  limit: number;
}
const cache = new Map<string, { data: LoanWithRisk[]; at: number }>();
const keyOf = (k: CacheKey) =>
  `${k.user}:${k.borrowerSide ? 'b' : 'l'}:${k.offset}:${k.limit}`;

export function useDashboardLoans(
  user: Address | null,
  borrowerSide: boolean,
  offset: number = 0,
  limit: number = DEFAULT_LIMIT,
) {
  const diamond = useDiamondRead();
  const cacheKey = user
    ? keyOf({ user: user.toLowerCase(), borrowerSide, offset, limit })
    : '';
  const [rows, setRows] = useState<LoanWithRisk[]>(
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
      flow: 'useDashboardLoans',
      step: `${borrowerSide ? 'borrower' : 'lender'}-side off=${offset} lim=${limit}`,
    });
    try {
      const raw = await (
        diamond as unknown as {
          getUserDashboardLoans: (
            u: Address,
            bSide: boolean,
            off: number,
            lim: number,
          ) => Promise<LoanWithRisk[]>;
        }
      ).getUserDashboardLoans(user, borrowerSide, offset, limit);
      cache.set(cacheKey, { data: raw, at: Date.now() });
      setRows(raw);
      step.success({ note: `${raw.length} rows` });
    } catch (err) {
      setError(err as Error);
      step.failure(err);
    } finally {
      setLoading(false);
    }
  }, [diamond, user, borrowerSide, offset, limit, cacheKey]);

  useEffect(() => {
    load();
  }, [load]);

  const reload = useCallback(async () => {
    cache.delete(cacheKey);
    await load();
  }, [load, cacheKey]);

  return { rows, loading, error, reload };
}

/** Test-only — wipes the per-page cache so a fresh fetch fires. */
export function __clearDashboardLoansCache() {
  cache.clear();
}
