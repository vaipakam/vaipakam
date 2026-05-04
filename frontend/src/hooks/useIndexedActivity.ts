/**
 * T-041 Phase B — worker-cached activity feed with browser fallback.
 *
 * Same `{ source, events, loading }` contract as the loan hooks.
 * Powers the Activity page, the LoanTimeline component (filtered by
 * loanId), and any per-wallet history surfaces (filtered by actor).
 *
 * Pagination is cursor-based on (block, logIndex) — the same shape
 * the worker emits as `nextBefore`. Callers append-on-load to
 * progressively grow the list.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  fetchActivity,
  type ActivityFilters,
  type IndexedActivityEvent,
} from '../lib/indexerClient';
import { useReadChain } from '../contracts/useDiamond';
import { DEFAULT_CHAIN } from '../contracts/config';
import { useLiveWatermark } from './useLiveWatermark';

const PAGE_LIMIT = 100;

interface UseIndexedActivityResult {
  events: IndexedActivityEvent[] | null;
  source: 'indexer' | 'fallback' | null;
  loading: boolean;
  hasMore: boolean;
  loadMore: () => Promise<void>;
  /** Imperative trigger — re-runs the initial-page fetch. Wired into
   *  the Activity page's rescan button so users can force fresh
   *  events without waiting for the next 2 s watermark tick. */
  refetch: () => Promise<void>;
}

export function useIndexedActivity(
  filters: Omit<ActivityFilters, 'limit' | 'before'> = {},
): UseIndexedActivityResult {
  const chain = useReadChain();
  const chainId = chain.chainId ?? DEFAULT_CHAIN.chainId;
  const { version } = useLiveWatermark();
  const [events, setEvents] = useState<IndexedActivityEvent[] | null>(null);
  const [source, setSource] = useState<'indexer' | 'fallback' | null>(null);
  const [loading, setLoading] = useState(true);
  const [nextBefore, setNextBefore] = useState<string | null>(null);

  // Stable filter key — re-fetch on filter change without churning.
  const filterKey = JSON.stringify(filters);

  useEffect(() => {
    let cancelled = false;
    async function initial() {
      setLoading(true);
      const page = await fetchActivity(chainId, { ...filters, limit: PAGE_LIMIT });
      if (cancelled) return;
      if (page) {
        setEvents(page.events);
        setSource('indexer');
        setNextBefore(page.nextBefore);
      } else {
        setEvents(null);
        setSource('fallback');
        setNextBefore(null);
      }
      setLoading(false);
    }
    void initial();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainId, filterKey, version]);

  const loadMore = useCallback(async () => {
    if (!nextBefore || source !== 'indexer') return;
    const page = await fetchActivity(chainId, {
      ...filters,
      limit: PAGE_LIMIT,
      before: nextBefore,
    });
    if (!page) return;
    setEvents((prev) => [...(prev ?? []), ...page.events]);
    setNextBefore(page.nextBefore);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainId, filterKey, nextBefore, source]);

  const refetch = useCallback(async () => {
    setLoading(true);
    const page = await fetchActivity(chainId, { ...filters, limit: PAGE_LIMIT });
    if (page) {
      setEvents(page.events);
      setSource('indexer');
      setNextBefore(page.nextBefore);
    } else {
      setEvents(null);
      setSource('fallback');
      setNextBefore(null);
    }
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainId, filterKey]);

  return {
    events,
    source,
    loading,
    hasMore: nextBefore !== null,
    loadMore,
    refetch,
  };
}
