import { useCallback, useEffect, useState } from 'react';
import type { Address } from 'viem';
import { useDiamondRead } from '../contracts/useDiamond';
import { beginStep } from '../lib/journeyLog';

const STALE_MS = 30_000;
const DEFAULT_LIMIT = 20;

/**
 * Page of pending claim rows for the connected user — lender side
 * (post-resolution proceeds) or borrower side (collateral refunds,
 * surplus, NFT rental returns, Phase 5 LIF VPFI rebates).
 * Backed by `MetricsDashboardFacet.getUserDashboardClaimables`.
 *
 * AnalyticalGettersDesign §3.1 / D3 — `borrowerSide` boolean
 * splits the two surfaces; the contract returns aligned `loanIds`
 * + `claims` arrays (parallel arrays — same length). The hook
 * folds them into a single shape so consumers can render row-by-
 * row without index gymnastics.
 */
export interface DashboardClaim {
  loanId: bigint;
  asset: Address;
  amount: bigint;
  assetType: number;
  tokenId: bigint;
  quantity: bigint;
}

interface CacheKey {
  user: string;
  borrowerSide: boolean;
  offset: number;
  limit: number;
}
const cache = new Map<string, { data: DashboardClaim[]; at: number }>();
const keyOf = (k: CacheKey) =>
  `${k.user}:${k.borrowerSide ? 'b' : 'l'}:${k.offset}:${k.limit}`;

export function useDashboardClaimables(
  user: Address | null,
  borrowerSide: boolean,
  offset: number = 0,
  limit: number = DEFAULT_LIMIT,
) {
  const diamond = useDiamondRead();
  const cacheKey = user
    ? keyOf({ user: user.toLowerCase(), borrowerSide, offset, limit })
    : '';
  const [rows, setRows] = useState<DashboardClaim[]>(
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
      flow: 'useDashboardClaimables',
      step: `${borrowerSide ? 'borrower' : 'lender'} off=${offset} lim=${limit}`,
    });
    try {
      const [ids, claims] = await (
        diamond as unknown as {
          getUserDashboardClaimables: (
            u: Address,
            bSide: boolean,
            off: number,
            lim: number,
          ) => Promise<
            [
              bigint[],
              {
                asset: Address;
                amount: bigint;
                assetType: number;
                tokenId: bigint;
                quantity: bigint;
              }[],
            ]
          >;
        }
      ).getUserDashboardClaimables(user, borrowerSide, offset, limit);

      const folded: DashboardClaim[] = ids.map((id, i) => ({
        loanId: id,
        asset: claims[i].asset,
        amount: BigInt(claims[i].amount),
        assetType: Number(claims[i].assetType),
        tokenId: BigInt(claims[i].tokenId),
        quantity: BigInt(claims[i].quantity),
      }));
      cache.set(cacheKey, { data: folded, at: Date.now() });
      setRows(folded);
      step.success({ note: `${folded.length} rows` });
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

/** Test-only — wipes the per-page cache. */
export function __clearDashboardClaimablesCache() {
  cache.clear();
}
