/**
 * T-041 Phase 1+2 — worker-cached active-offer list with browser
 * fallback.
 *
 * Returns one of three states:
 *
 *   - `{ source: 'indexer', offers, loading: false }` — worker
 *     returned a fresh page; OfferBook can render directly without
 *     paginating per-id `getOfferDetails` calls.
 *   - `{ source: 'fallback', offers: null, loading: false }` —
 *     worker is unreachable / errored. Caller falls through to its
 *     existing `useLogIndex`-driven path (and the per-id RPC
 *     pagination it implies).
 *   - `{ source: null, offers: null, loading: true }` — initial
 *     pre-fetch state.
 *
 * The hook re-fetches every 30s so a freshly created offer surfaces
 * without a manual reload. OfferBook's `watchContractEvent` on
 * `OfferCreated` / `OfferAccepted` / `OfferCanceled` already triggers
 * its own debounced rescan via `useLogIndex`; that continues to work
 * regardless of which source supplies the rendered offers.
 */

import { useEffect, useState } from 'react';
import {
  fetchActiveOffers,
  type IndexedOffer,
} from '../lib/indexerClient';
import { useReadChain } from '../contracts/useDiamond';
import { DEFAULT_CHAIN } from '../contracts/config';

const PAGE_LIMIT = 200;
const REFRESH_MS = 30_000;

interface UseIndexedActiveOffersResult {
  offers: IndexedOffer[] | null;
  source: 'indexer' | 'fallback' | null;
  loading: boolean;
}

export function useIndexedActiveOffers(): UseIndexedActiveOffersResult {
  const chain = useReadChain();
  const chainId = chain.chainId ?? DEFAULT_CHAIN.chainId;
  const [offers, setOffers] = useState<IndexedOffer[] | null>(null);
  const [source, setSource] = useState<'indexer' | 'fallback' | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      const page = await fetchActiveOffers(chainId, { limit: PAGE_LIMIT });
      if (cancelled) return;
      if (page) {
        setOffers(page.offers);
        setSource('indexer');
      } else {
        setOffers(null);
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
  }, [chainId]);

  return { offers, source, loading };
}
