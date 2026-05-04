/**
 * Worker-cached active-offer list with browser fallback, wired
 * through the live-tail pattern.
 *
 * Returns one of three states:
 *
 *   - `{ source: 'indexer', offers, loading: false }` — worker
 *     returned a fresh page; OfferBook can render directly without
 *     paginating per-id `getOfferDetails` calls.
 *   - `{ source: 'fallback', offers: null, loading: false }` —
 *     worker is unreachable / errored. Caller falls through to its
 *     existing `useLogIndex`-driven path.
 *   - `{ source: null, offers: null, loading: true }` — initial
 *     pre-fetch state.
 *
 * Live-tail flow:
 *
 *   1. Mount + tab focus + watermark advance (= someone created an
 *      offer or a loan landed): refetch the indexer page.
 *   2. After the indexer page lands, run a chunked `eth_getLogs`
 *      catch-up over `[indexer.lastBlock + 1, watermark.safeBlock]`
 *      and merge: drop terminal offer IDs from the indexer page;
 *      new IDs flagged by the catch-up will be picked up by the next
 *      indexer cron run (we don't fetch them per-id here — the
 *      additional RPC cost wasn't justified for offers, where the
 *      indexer cron is the canonical source of new rows).
 *   3. Catch-up uses `blockTag: 'safe'` and 1000-block windows
 *      (`chunkedGetLogs` defaults).
 */

import { useEffect, useState } from 'react';
import { usePublicClient } from 'wagmi';
import { type Address } from 'viem';
import {
  fetchActiveOffers,
  type IndexedOffer,
} from '../lib/indexerClient';
import { useReadChain } from '../contracts/useDiamond';
import { DEFAULT_CHAIN } from '../contracts/config';
import { useLiveWatermark } from './useLiveWatermark';
import {
  chunkedGetLogs,
  decodeOfferDelta,
  TOPIC0,
} from '../lib/rpcCatchUp';

const PAGE_LIMIT = 200;

interface UseIndexedActiveOffersResult {
  offers: IndexedOffer[] | null;
  source: 'indexer' | 'fallback' | null;
  loading: boolean;
}

export function useIndexedActiveOffers(): UseIndexedActiveOffersResult {
  const chain = useReadChain();
  const chainId = chain.chainId ?? DEFAULT_CHAIN.chainId;
  const diamond = chain.diamondAddress;
  const publicClient = usePublicClient();
  const { version, snapshot } = useLiveWatermark();
  const [offers, setOffers] = useState<IndexedOffer[] | null>(null);
  const [source, setSource] = useState<'indexer' | 'fallback' | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      const page = await fetchActiveOffers(chainId, { limit: PAGE_LIMIT });
      if (cancelled) return;
      if (!page) {
        setOffers(null);
        setSource('fallback');
        setLoading(false);
        return;
      }

      // Bridge the indexer-tail → safe-head gap with a chunked log
      // catch-up. Skip when the watermark probe is still warming up,
      // or when we don't have a public client / diamond address. In
      // those edge cases the indexer page renders as-is and the next
      // tick reruns once the watermark settles.
      const fromBlock =
        page.offers.length > 0 || (page as { nextBefore?: unknown }).nextBefore
          ? // Pull the largest known indexer block from the page rows
            // — that's our true tail. Fall back to 0 if the page is
            // empty (then catch-up runs from genesis only when there
            // are no offers indexed yet, which on a working deploy is
            // a brief warmup state).
            BigInt(
              page.offers.reduce(
                (m, o) => (o.firstSeenBlock > m ? o.firstSeenBlock : m),
                0,
              ),
            )
          : 0n;

      let terminalIds = new Set<string>();
      let createdIds: bigint[] = [];
      if (publicClient && diamond && snapshot && snapshot.safeBlock > fromBlock) {
        const logs = await chunkedGetLogs(publicClient, {
          fromBlock: fromBlock + 1n,
          toBlock: snapshot.safeBlock,
          address: diamond as Address,
          topics: [
            [TOPIC0.OFFER_CREATED, TOPIC0.OFFER_ACCEPTED, TOPIC0.OFFER_CANCELED],
          ],
        });
        if (cancelled) return;
        const delta = decodeOfferDelta(logs);
        terminalIds = new Set(delta.terminal.map((id) => id.toString()));
        createdIds = delta.created;
      }

      const merged = page.offers.filter(
        (o) => !terminalIds.has(o.offerId.toString()),
      );
      // `createdIds` is informational here — we don't hydrate the new
      // rows synchronously. The next indexer cron picks them up; in
      // the meantime the OfferBook UI is consistent (no stale-but-
      // -terminal rows showing) and the next watermark version bump
      // re-runs this effect to surface them. This trades a brief
      // (~60 s) "missing new offer" window for cheap RPC usage.
      void createdIds;

      setOffers(merged);
      setSource('indexer');
      setLoading(false);
    }
    void tick();
    return () => {
      cancelled = true;
    };
  }, [chainId, version, publicClient, diamond, snapshot]);

  return { offers, source, loading };
}
