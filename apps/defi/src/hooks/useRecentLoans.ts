import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchRecentLoans, type IndexedLoan } from '../lib/indexerClient';
import { useReadChain } from '../contracts/useDiamond';
import { DEFAULT_CHAIN } from '../contracts/config';
import { useLiveWatermark } from './useLiveWatermark';
import { watermarkPolicy } from './watermarkPolicy';

interface UseRecentLoansResult {
  loans: IndexedLoan[];
  loading: boolean;
  /** Imperative trigger — re-fetch even when no watermark dep changed
   *  (manual rescan). */
  reload: () => Promise<void>;
}

/**
 * Indexer-first "latest N loans across every status" feed for the
 * Analytics page's Recent Activity table. Backed by `/loans/recent` on
 * the worker — the same endpoint Dashboard's per-wallet loan lists read
 * a filtered slice of.
 *
 * The Analytics page previously sourced this list from
 * `useProtocolStats.loans` (the full per-loan `getLoanDetails`
 * multicall), which was lazy-disabled on the happy path to kill the
 * multicall storm — leaving the table permanently empty. This hook
 * restores it from the indexer, no chain reads.
 *
 * Staleness handling: a chain switch clears the list (the prior chain's
 * loans are meaningless), but a *transient* indexer failure on a later
 * refresh keeps the last-good list rather than blanking it — that's
 * what stops the table flickering empty↔populated while the worker is
 * briefly slow under a refetch burst.
 *
 * Cool-tier auto-refresh: 180 s active, 600 s idle, pause @ 15 min —
 * aggregate surface, sub-minute refresh would be theatre.
 */
export function useRecentLoans(limit = 50): UseRecentLoansResult {
  const chain = useReadChain();
  const chainId = chain.chainId ?? DEFAULT_CHAIN.chainId;
  const { version } = useLiveWatermark(watermarkPolicy('cool'));
  const [loans, setLoans] = useState<IndexedLoan[]>([]);
  const [loading, setLoading] = useState(true);
  // Tracks the chain the current `loans` belong to, so the fetch can
  // tell "first load / chain switch" (→ clear, then fill) from "scheduled
  // refresh on the same chain" (→ keep last-good if the fetch flakes).
  const loadedChainRef = useRef<number | null>(null);

  const run = useCallback(async () => {
    const isNewChain = loadedChainRef.current !== chainId;
    if (isNewChain) {
      setLoans([]);
      loadedChainRef.current = chainId;
    }
    setLoading(true);
    try {
      const page = await fetchRecentLoans(chainId, { limit });
      if (page) setLoans(page.loans);
      // page === null → worker unreachable; keep whatever's there
      // (empty on a fresh chain, last-good on a refresh).
    } finally {
      setLoading(false);
    }
  }, [chainId, limit]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const isNewChain = loadedChainRef.current !== chainId;
      if (isNewChain) {
        setLoans([]);
        loadedChainRef.current = chainId;
      }
      setLoading(true);
      try {
        const page = await fetchRecentLoans(chainId, { limit });
        if (!cancelled && page) setLoans(page.loans);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chainId, limit, version]);

  return { loans, loading, reload: run };
}
