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

import { useCallback, useEffect, useRef, useState } from 'react';
import { type Address } from 'viem';
import {
  fetchActiveOffers,
  type IndexedOffer,
} from '../lib/indexerClient';
import { useDiamondPublicClient, useReadChain } from '../contracts/useDiamond';
import { DEFAULT_CHAIN } from '../contracts/config';
import { useLiveWatermark } from './useLiveWatermark';
import { watermarkPolicy } from './watermarkPolicy';
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
  /** Imperative trigger — re-runs the indexer fetch + RPC catch-up
   *  pipeline. Wired into the OfferBook rescan button so users who
   *  want fresh data right now don't have to wait for the next 5 s
   *  watermark tick. The auto-refresh path (mount / focus / version
   *  bump) keeps running independently. */
  refetch: () => Promise<void>;
}

export function useIndexedActiveOffers(): UseIndexedActiveOffersResult {
  const chain = useReadChain();
  const chainId = chain.chainId ?? DEFAULT_CHAIN.chainId;
  const diamond = chain.diamondAddress;
  const publicClient = useDiamondPublicClient();
  // OfferBook is the one surface where the 5 s polling cadence is
  // load-bearing — users actively watch for new offers landing. Other
  // hooks pass `pollIntervalMs: null` to skip the timer; this hook
  // explicitly opts in to the active 5 s cadence.
  //
  // Activity-aware tiers: while the tab is focused AND the user is
  // actually interacting with the page, poll at 5 s. After 5 minutes
  // of no input, slow to 30 s — same data freshness, 6× cheaper RPC,
  // good enough for a returning user who's been reading something
  // off-screen. After 15 minutes of no input, pause entirely; the
  // user has either walked away or genuinely left the tab open as a
  // background reference, and either way the next mouse-wiggle /
  // keypress / scroll / touch fires an immediate catch-up probe.
  // Tab-focus events count as activity and reset the timer to 0.
  const { version, snapshot } = useLiveWatermark(watermarkPolicy('hot'));
  const [offers, setOffers] = useState<IndexedOffer[] | null>(null);
  const [source, setSource] = useState<'indexer' | 'fallback' | null>(null);
  const [loading, setLoading] = useState(true);

  // Mirror `snapshot` into a ref so the watermark probe's 5 s cadence
  // doesn't churn `tick`'s identity. The probe builds a new snapshot
  // OBJECT on every tick (even when neither counter advanced — the
  // `safeBlock` value alone changes every block), and putting that
  // object in `tick`'s dep list propagated up through the effect that
  // calls `tick`, so the OfferBook was firing an indexer fetch +
  // chunked-getLogs catch-up every 5 s instead of only on actual
  // counter advance. The ref pattern reads the latest snapshot at
  // call-time without making `tick` reactive to it. The catch-up
  // window's upper bound (`snapshotRef.current?.safeBlock`) is
  // therefore "freshest known safe block at the moment the refetch
  // ran", which is exactly what we want.
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  const tick = useCallback(
    async (signal?: { cancelled: boolean }) => {
      // Paginate through every page of `/offers/active` until the
      // worker says "no more pages" (`nextBefore === null`). Hard-
      // capped at 25 pages × 200 = 5000 active offers — plenty of
      // headroom; if the protocol ever genuinely exceeds that, lift
      // the cap. Without pagination the OfferBook would silently
      // truncate to the first 200 active offers, which on a busy
      // mainnet would hide the rest of the book from users. Same
      // shape as the TVL paginator in useTVL.
      const allOffers: IndexedOffer[] = [];
      let before: number | undefined = undefined;
      for (let i = 0; i < 25; i++) {
        const page = await fetchActiveOffers(chainId, { limit: PAGE_LIMIT, before });
        if (signal?.cancelled) return;
        if (!page) {
          // Worker unreachable mid-pagination. Bail out and let the
          // chain-side log-scan fallback (consumed by OfferBook
          // when `source === 'fallback'`) take over.
          setOffers(null);
          setSource('fallback');
          setLoading(false);
          return;
        }
        allOffers.push(...page.offers);
        if (page.nextBefore === null) break;
        before = page.nextBefore;
      }

      const fromBlock =
        allOffers.length > 0
          ? BigInt(
              allOffers.reduce(
                (m, o) => (o.firstSeenBlock > m ? o.firstSeenBlock : m),
                0,
              ),
            )
          : 0n;

      let terminalIds = new Set<string>();
      let createdIds: bigint[] = [];
      const liveSnapshot = snapshotRef.current;
      if (publicClient && diamond && liveSnapshot && liveSnapshot.safeBlock > fromBlock) {
        const logs = await chunkedGetLogs(publicClient, {
          fromBlock: fromBlock + 1n,
          toBlock: liveSnapshot.safeBlock,
          address: diamond as Address,
          topics: [
            [TOPIC0.OFFER_CREATED, TOPIC0.OFFER_ACCEPTED, TOPIC0.OFFER_CANCELED],
          ],
        });
        if (signal?.cancelled) return;
        const delta = decodeOfferDelta(logs);
        terminalIds = new Set(delta.terminal.map((id) => id.toString()));
        createdIds = delta.created;
      }

      const merged = allOffers.filter(
        (o) => !terminalIds.has(o.offerId.toString()),
      );
      // `createdIds` is informational here — we don't hydrate the new
      // rows synchronously. The next indexer cron picks them up; in
      // the meantime the OfferBook UI is consistent (no stale-but-
      // -terminal rows showing) and the next watermark version bump
      // re-runs this effect to surface them.
      void createdIds;

      setOffers(merged);
      setSource('indexer');
      setLoading(false);
    },
    [chainId, publicClient, diamond],
  );

  useEffect(() => {
    const signal = { cancelled: false };
    void tick(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [version, tick]);

  const refetch = useCallback(async () => {
    await tick();
  }, [tick]);

  return { offers, source, loading, refetch };
}
