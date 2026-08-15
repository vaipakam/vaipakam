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
  // Tagged with the whole question — which chain, whose wallet. Both `loading`
  // and the empty disabled answer are DERIVED, not written from the effect,
  // which is what removes the frame where one wallet's open claims are listed
  // under another wallet's name. The 30 s poll re-stamps the same tag, so a
  // refresh does not flicker back through a loading state.
  const reqKey = address ? `${chainId}|${address.toLowerCase()}` : null;
  const [result, setResult] = useState<{
    key: string;
    data: ClaimablesResponse | null;
    source: 'indexer' | 'fallback';
  } | null>(null);

  useEffect(() => {
    if (!reqKey || !address) return;
    let cancelled = false;
    async function tick() {
      const wallet = address as string;
      const next = await fetchClaimables(chainId, wallet);
      if (cancelled) return;
      setResult(
        next
          ? { key: reqKey as string, data: next, source: 'indexer' }
          : { key: reqKey as string, data: null, source: 'fallback' },
      );
    }
    void tick();
    const interval = setInterval(tick, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
      // Dropped on the way out, so reconnecting the same wallet after a
      // disconnect reads as loading rather than as the claim list from before
      // it — a stale "nothing to claim" is the reading that costs a user money.
      setResult(null);
    };
  }, [chainId, address, reqKey]);

  const matched = result?.key === reqKey;
  return {
    data: matched ? result.data : null,
    source: matched ? result.source : null,
    loading: reqKey !== null && !matched,
  };
}
