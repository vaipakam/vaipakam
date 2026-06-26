import { useCallback, useEffect, useRef, useState } from 'react';
import type { Address } from 'viem';
import { useReadyDiamond, useReadChain } from '../contracts/useDiamond';
import { beginStep } from '../lib/journeyLog';

const STALE_MS = 30_000;
const DEFAULT_LIMIT = 10;

/**
 * One row of `LenderIntentFacet.getLenderIntentsByOwner` — the shared
 * intent summary plus an `active` flag the global keeper feed doesn't
 * carry (it lists only active intents; the per-owner view also surfaces
 * PAUSED, cancelled-but-capital-reserved intents). Amounts are raw base
 * units of the row's `intent.lendingAsset`.
 *
 * `maxInitLtvBps` (uint16) and `maxDurationDays` (uint32) decode to
 * `number` under viem's <=48-bit rule; every uint256 stays `bigint`.
 */
export interface LenderIntentSummary {
  owner: Address;
  lendingAsset: Address;
  collateralAsset: Address;
  maxExposure: bigint;
  minRateBps: bigint;
  maxInitLtvBps: number;
  maxDurationDays: number;
  minFillAmount: bigint;
  requiresKeeperAuth: boolean;
  livePrincipal: bigint;
  availableCapital: bigint;
}

export interface OwnerLenderIntentSummary {
  intent: LenderIntentSummary;
  active: boolean;
}

interface CacheKey {
  chainId: number;
  user: string;
  offset: number;
  limit: number;
  refreshKey: number;
}
// Cache key chain-prefixed — see useDashboardOffers.ts for the
// 2026-05-11 chain-switch-stale-data fix.
const cache = new Map<
  string,
  { rows: OwnerLenderIntentSummary[]; total: bigint; at: number }
>();
// `refreshKey` is part of the key so an explicit bump (e.g. after the
// auto-lend card mutates an intent) misses the 30s cache and refetches,
// via the same load effect — no extra setState-in-effect refresh path.
const keyOf = (k: CacheKey) =>
  `${k.chainId}:${k.user}:${k.offset}:${k.limit}:${k.refreshKey}`;

// Diamond `FunctionNotFound(bytes4)` selector — a chain whose deployed
// Diamond predates the #756 facet upgrade reverts with it. Treated as
// "facet absent" (empty, non-error) so the overview self-hides rather
// than showing a permanent error, mirroring AutoLendIntentCard's
// missing-facet path.
function isMissingFacetError(err: unknown): boolean {
  const msg = String(
    (err as { data?: string; message?: string })?.data ??
      (err as Error)?.message ??
      '',
  );
  return (
    msg.includes('0xa9ad62f8') ||
    /function does not exist|functionnotfound/i.test(msg)
  );
}

/**
 * #755 — paginated list of every standing lender-intent `user` owns
 * across pairs, so the dapp can show and manage them in one place
 * (the global keeper feed is owner-agnostic and funded-active only).
 *
 * Server-paginated: `total` is the owner's full intent count from the
 * contract, so the {Pager} stays correct even past one page. Mirrors
 * {useDashboardLoansBothSides} — `useReadyDiamond` bails to an empty,
 * non-error state on chains without a Diamond (or before the intent
 * facet is cut), and a 30s chain-prefixed cache de-dupes refetches.
 */
export function useLenderIntentsByOwner(
  user: Address | null,
  offset: number = 0,
  limit: number = DEFAULT_LIMIT,
  refreshKey: number = 0,
) {
  const diamond = useReadyDiamond();
  const chain = useReadChain();
  const cacheKey = user
    ? keyOf({
        chainId: chain.chainId,
        user: user.toLowerCase(),
        offset,
        limit,
        refreshKey,
      })
    : '';
  // Single cache read for both initial-state seeds (one impure render-time
  // read, not two — keeps the React Compiler able to reason about the hook).
  const seed = cache.get(cacheKey);
  const [rows, setRows] = useState<OwnerLenderIntentSummary[]>(seed?.rows ?? []);
  const [total, setTotal] = useState<bigint>(seed?.total ?? 0n);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  // Latest in-scope request key, so a slow response for a now-stale
  // owner/chain/page/refresh doesn't overwrite the current list. Written
  // in an effect (ref writes don't belong in render).
  const latestKeyRef = useRef(cacheKey);
  useEffect(() => {
    latestKeyRef.current = cacheKey;
  }, [cacheKey]);

  const load = useCallback(async () => {
    if (!user) {
      setRows([]);
      setTotal(0n);
      setError(null);
      setLoading(false);
      return;
    }
    // useReadyDiamond returns null on chains without a Diamond (or where
    // the intent facet isn't cut) — render an empty, non-error state.
    if (!diamond) {
      setRows([]);
      setTotal(0n);
      setLoading(false);
      setError(null);
      return;
    }
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.at < STALE_MS) {
      setRows(cached.rows);
      setTotal(cached.total);
      setError(null);
      setLoading(false);
      return;
    }
    const requestedKey = cacheKey;
    setLoading(true);
    setError(null);
    const step = beginStep({
      area: 'dashboard',
      flow: 'useLenderIntentsByOwner',
      step: `off=${offset} lim=${limit}`,
    });
    try {
      const [intents, count] = await (
        diamond as unknown as {
          getLenderIntentsByOwner: (
            u: Address,
            off: number,
            lim: number,
          ) => Promise<[OwnerLenderIntentSummary[], bigint]>;
        }
      ).getLenderIntentsByOwner(user, offset, limit);
      cache.set(requestedKey, { rows: intents, total: count, at: Date.now() });
      // Drop a response the user has already navigated away from.
      if (latestKeyRef.current !== requestedKey) return;
      setRows(intents);
      setTotal(count);
      step.success({
        note: `${intents.length}/${count.toString()} intents (active ${
          intents.filter((r) => r.active).length
        })`,
      });
    } catch (err) {
      if (latestKeyRef.current !== requestedKey) return;
      if (isMissingFacetError(err)) {
        // Facet not cut on this lagging deploy → empty + non-error so the
        // overview self-hides (like the auto-lend card's missing-facet path).
        setRows([]);
        setTotal(0n);
        setError(null);
        step.success({ note: 'facet not cut — hidden' });
      } else {
        setError(err as Error);
        step.failure(err);
      }
    } finally {
      // Only the request that still owns the key clears the spinner.
      if (latestKeyRef.current === requestedKey) setLoading(false);
    }
  }, [diamond, user, offset, limit, cacheKey]);

  useEffect(() => {
    // Data-sync effect: pulls the paginated read into React state. All
    // network-derived writes are post-await; the early-return branches set
    // state synchronously, so the rule flags the call site regardless — opt
    // out exactly as the auto-lend card's data-loading effects do.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const reload = useCallback(async () => {
    cache.delete(cacheKey);
    await load();
  }, [load, cacheKey]);

  return { rows, total, loading, error, reload };
}

/** Test-only — wipes the per-page cache. */
export function __clearLenderIntentsByOwnerCache() {
  cache.clear();
}
