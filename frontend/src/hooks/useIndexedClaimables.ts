/**
 * T-041 Phase E — worker-cached open-claim list with browser
 * fallback. Same `{ source, loading }` contract as the loan hooks.
 *
 * The hook walks the wallet's lender-side AND borrower-side terminal
 * loans whose matching `*FundsClaimed` event has not yet fired,
 * derived server-side from `loans` JOIN `activity_events`. Powers the
 * Claim Center landing card; on `source === 'fallback'`, the page
 * falls back to its existing `useLogIndex`-driven scan.
 */

import { useEffect, useState } from 'react';
import {
  fetchClaimables,
  type ClaimablesResponse,
} from '../lib/indexerClient';
import { useReadChain } from '../contracts/useDiamond';
import { DEFAULT_CHAIN } from '../contracts/config';

const REFRESH_MS = 30_000;

interface UseIndexedClaimablesResult {
  data: ClaimablesResponse | null;
  source: 'indexer' | 'fallback' | null;
  loading: boolean;
}

export function useIndexedClaimables(
  address: string | undefined,
): UseIndexedClaimablesResult {
  const chain = useReadChain();
  const chainId = chain.chainId ?? DEFAULT_CHAIN.chainId;
  const [data, setData] = useState<ClaimablesResponse | null>(null);
  const [source, setSource] = useState<'indexer' | 'fallback' | null>(null);
  const [loading, setLoading] = useState(Boolean(address));

  useEffect(() => {
    if (!address) {
      setData(null);
      setSource(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    async function tick() {
      const wallet = address as string;
      const next = await fetchClaimables(chainId, wallet);
      if (cancelled) return;
      if (next) {
        setData(next);
        setSource('indexer');
      } else {
        setData(null);
        setSource('fallback');
      }
      setLoading(false);
    }
    void tick();
    const interval = setInterval(tick, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [chainId, address]);

  return { data, source, loading };
}
