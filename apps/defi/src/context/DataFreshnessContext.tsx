/**
 * Page data-freshness registry.
 *
 * Backs the IndexerStatusBadge's "is what I'm looking at trustworthy?"
 * signal. The badge needs two independent facts, and neither is fully
 * captured by the central indexer's `lastBlock` alone:
 *
 *  1. **Frontier freshness** — how recent is the data on screen, in
 *     block-space? The freshest block is `max(indexer.lastBlock,
 *     <every client-side RPC tail-scan's scanned-through block>)`. The
 *     tail scans (chunked `eth_getLogs` over `[indexer.lastBlock+1,
 *     watermark.safeBlock]` that `useIndexedActiveOffers` /
 *     `useIndexedLoans` run on top of the indexer page) routinely push
 *     the effective frontier to the chain head even when the central
 *     indexer is thousands of blocks behind. Without folding those in,
 *     the badge reads "5000 blocks behind" while the page is actually
 *     fresh-to-head.
 *
 *  2. **Idle** — is any data fetch still in flight? A fresh frontier
 *     doesn't mean the DOM is done painting — a `getLoanDetails`
 *     multicall fan-out or an offer-page paginator can still be
 *     running. "Green" should mean fresh frontier AND nothing loading,
 *     so that "badge is green" ⟺ "the page shows near-real-time data".
 *
 * Each data hook calls `report(source, patch)` to update its slice:
 * its scanned-through block (`frontier`, monotonic-forward within a
 * chain) and/or its `loading` flag. The provider exposes the max
 * frontier and the OR of all loading flags; the badge derives its
 * 3-state colour from those plus the watermark's chain-safe-head.
 *
 * Keyed by chainId — switching chains clears every reported slice (the
 * prior chain's blocks/flags are meaningless on the new chain).
 *
 * # Indexer-fallback trigger (`fallbackVersion`)
 *
 * `version`-bumps on `WatermarkContext` only fire when `nextOfferId` or
 * `nextLoanId` advance on chain — i.e. **creates**. State-change events
 * on existing offers/loans (`OfferAccepted`, `OfferCancelled`,
 * `LoanRepaid`, `PartialRepaid`, `CollateralAdded`, `LoanRefinanced`,
 * `LoanPreclosed*`, `OffsetCompleted`, `LoanDefaulted`) and NFT
 * `Transfer`s do NOT bump it. In the common case those are covered by
 * the central indexer cron (it scans every minute and the `offerStats`
 * lane polls it every 30 s). In the rare-but-real case where the
 * indexer is unreachable or stale, the per-page RPC tail-scan would
 * stay frozen until someone creates a new offer/loan — i.e. silent
 * staleness on the client.
 *
 * `fallbackVersion` plugs that gap. It bumps when BOTH:
 *   - the indexer's `frontier` (= `offerStats.indexer.lastBlock`)
 *     hasn't advanced in > `INDEXER_STALE_SEC` (= 120 s); AND
 *   - the chain's `safeBlock` has advanced past the freshest RPC
 *     tail-scan frontier by > `FALLBACK_GAP_BLOCKS` (= 200 blocks).
 *
 * Tail-scan hooks (`useIndexedActiveOffers`, `useIndexedLoans`,
 * `useLogIndex`) include `fallbackVersion` in their effect dep array
 * alongside `version`. Net effect: in the steady state (indexer
 * healthy) `fallbackVersion` never bumps and no extra RPC is spent;
 * in the indexer-down edge case the tail-scan re-fires once safe-head
 * runs ~200 blocks past it. Cost is bounded — at most one re-fire per
 * ~200-block window per affected hook.
 *
 * Client-side only — not a Worker / indexer concern.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useReadChain } from '../contracts/useDiamond';
import { useWatermarkContext } from './WatermarkContext';

/** Stable keys for the known reporters. Add one here when wiring a new
 *  data hook into the registry. */
export type FreshnessSource =
  | 'offerStats' // useOfferStats — reports the central indexer's lastBlock + loading
  | 'activeOffers' // useIndexedActiveOffers — RPC tail-scan frontier + loading
  | 'activeLoans' // useIndexedActiveLoans — RPC tail-scan frontier + loading
  | 'roleLoans' // useIndexedRoleLoans (lender/borrower) — RPC tail-scan frontier + loading
  | 'userLoans' // useUserLoans — on-chain view + multicall; loading only (reads at latest)
  | 'logIndex'; // useLogIndex — legacy log scan; loading only

interface SourceSlice {
  /** Highest block this source confirmed it scanned through. Undefined
   *  for sources that read point-in-time (`latest`) and don't track a
   *  scanned range. */
  frontier?: number;
  /** Whether this source currently has a fetch in flight. */
  loading?: boolean;
  /** Unix-seconds at which `frontier` last *advanced*. Used by the
   *  indexer-fallback trigger to distinguish "indexer is healthy and
   *  steady" from "indexer is dead but its last value is still in the
   *  cache". Only updated when frontier moves forward; constant when
   *  the source merely re-reports the same value. */
  frontierAt?: number;
}

interface DataFreshnessContextValue {
  /** Max `frontier` over all sources that report one, or `null` if
   *  none has reported a frontier yet on this chain. */
  maxFrontier: number | null;
  /** OR of every source's `loading` flag — true while any registered
   *  data fetch is in flight. */
  anyLoading: boolean;
  /** Per-source breakdown — drives the badge popover's detail rows. */
  bySource: Readonly<Record<string, SourceSlice>>;
  /** Counter that bumps when the indexer-fallback trigger fires (see
   *  file-level doc). Tail-scan hooks include this in their effect dep
   *  array to refetch when the indexer can't keep them fresh. */
  fallbackVersion: number;
  /** A source updates its slice. Pass only the fields that changed.
   *  `frontier` is clamped monotonic-forward within a chain; `loading`
   *  is set/cleared freely. */
  report: (source: FreshnessSource, patch: SourceSlice) => void;
}

const DataFreshnessContext = createContext<DataFreshnessContextValue | null>(null);

/** RPC tail-scan source keys — anything reporting a `frontier` that
 *  represents a chunked-getLogs catch-up (as opposed to the central
 *  indexer's `lastBlock` reported by `offerStats`). The fallback
 *  trigger compares safe-head to the max of these. */
const TAIL_SCAN_SOURCES: readonly FreshnessSource[] = [
  'logIndex',
  'activeOffers',
  'activeLoans',
  'roleLoans',
];

/** Indexer is considered stale when its frontier hasn't advanced for
 *  this long. The indexer cron runs every ~60 s server-side, and the
 *  client polls it every 30 s — so two consecutive idle polls (~60 s
 *  + headroom) is the threshold. 120 s avoids tripping on a single
 *  slow cron tick. */
const INDEXER_STALE_SEC = 120;

/** Safe-head must have advanced this many blocks past the freshest
 *  tail-scan frontier before the fallback fires. Bounds the worst-case
 *  re-fire cadence (in block-time, not wall-clock — on Base ~2 s/block,
 *  200 blocks ≈ 6.6 min between forced re-fires). */
const FALLBACK_GAP_BLOCKS = 200;

/** Wall-clock cadence at which we evaluate the trigger. The conditions
 *  are read-only against state we already track; no RPC. 30 s matches
 *  the `warm`-tier watermark + offerStats heartbeat — keeps the
 *  evaluation aligned with the source-of-truth ticks. */
const FALLBACK_TICK_MS = 30_000;

export function DataFreshnessProvider({ children }: { children: ReactNode }) {
  const chain = useReadChain();
  const chainId = chain.chainId;
  const { snapshot: watermarkSnapshot } = useWatermarkContext();

  const slicesRef = useRef<Record<string, SourceSlice>>({});
  const [slices, setSlices] = useState<Record<string, SourceSlice>>({});
  const [fallbackVersion, setFallbackVersion] = useState(0);
  /** Safe-block at which the fallback last fired. New fires require
   *  another full FALLBACK_GAP_BLOCKS of advance past this — without
   *  this we'd bump every tick once the trigger is open. */
  const lastFallbackSafeBlockRef = useRef<number>(0);
  /** Cached watermark snapshot so the tick effect can read fresh
   *  safe-head + age without re-subscribing every render. */
  const watermarkSnapshotRef = useRef(watermarkSnapshot);
  useEffect(() => {
    watermarkSnapshotRef.current = watermarkSnapshot;
  }, [watermarkSnapshot]);

  useEffect(() => {
    // Chain switch (or first mount): drop everything. A stale higher
    // frontier from the prior chain would make the badge claim
    // freshness it doesn't have on the new chain. Reset the fallback
    // gate too so a chain-switch can immediately re-evaluate.
    slicesRef.current = {};
    setSlices({});
    lastFallbackSafeBlockRef.current = 0;
  }, [chainId]);

  const report = useCallback((source: FreshnessSource, patch: SourceSlice) => {
    const prev = slicesRef.current[source] ?? {};
    const next: SourceSlice = { ...prev };
    let changed = false;

    if (patch.frontier !== undefined) {
      const n = Number(patch.frontier);
      if (Number.isFinite(n) && n > 0 && n > (prev.frontier ?? 0)) {
        next.frontier = n;
        // Stamp `frontierAt` only on actual advance, not on every
        // re-report of the same value. That's what lets the fallback
        // trigger tell "indexer is alive and steady" from "indexer is
        // dead but cached".
        next.frontierAt = Math.floor(Date.now() / 1000);
        changed = true;
      }
    }
    if (patch.loading !== undefined && patch.loading !== prev.loading) {
      next.loading = patch.loading;
      changed = true;
    }
    if (!changed) return;

    slicesRef.current = { ...slicesRef.current, [source]: next };
    setSlices(slicesRef.current);
  }, []);

  /** Tick — evaluate the fallback trigger every FALLBACK_TICK_MS. No
   *  RPC, just a read of state we already maintain. */
  useEffect(() => {
    const evaluate = () => {
      const snap = watermarkSnapshotRef.current;
      if (!snap) return;
      const safeHead = Number(snap.safeBlock);
      if (!Number.isFinite(safeHead) || safeHead <= 0) return;

      // Indexer health: frontier reported AND last advanced within
      // INDEXER_STALE_SEC. Missing-entirely or stuck-for-too-long both
      // count as "unhealthy" — the fallback exists for both shapes.
      const offerStats = slicesRef.current['offerStats'];
      const now = Math.floor(Date.now() / 1000);
      const indexerAge =
        offerStats?.frontierAt !== undefined ? now - offerStats.frontierAt : Infinity;
      const indexerHealthy = indexerAge <= INDEXER_STALE_SEC;
      if (indexerHealthy) return;

      // Max frontier across the tail-scan lanes (= the page's actual
      // RPC-confirmed coverage, independent of the indexer cache).
      let tailFrontier = 0;
      for (const key of TAIL_SCAN_SOURCES) {
        const f = slicesRef.current[key]?.frontier;
        if (f !== undefined && f > tailFrontier) tailFrontier = f;
      }

      const gap = safeHead - tailFrontier;
      if (gap <= FALLBACK_GAP_BLOCKS) return;

      // Gate: require another FALLBACK_GAP_BLOCKS of safe-head
      // advance since the last bump. Without this the trigger is open
      // continuously while the indexer is down and we'd bump every
      // tick (= effectively "tail-scan every 30 s", which is what the
      // design explicitly avoids).
      if (safeHead - lastFallbackSafeBlockRef.current <= FALLBACK_GAP_BLOCKS) return;

      lastFallbackSafeBlockRef.current = safeHead;
      setFallbackVersion((v) => v + 1);
    };

    // Don't evaluate the moment the provider mounts — the indexer
    // hasn't had a chance to report yet, and we'd otherwise fire a
    // spurious fallback before the offerStats heartbeat lands its
    // first frontier. One full tick of grace is fine.
    const id = setInterval(evaluate, FALLBACK_TICK_MS);
    return () => clearInterval(id);
  }, [chainId]);

  const { maxFrontier, anyLoading } = useMemo(() => {
    let max: number | null = null;
    let loading = false;
    for (const s of Object.values(slices)) {
      if (s.frontier !== undefined && (max === null || s.frontier > max)) max = s.frontier;
      if (s.loading) loading = true;
    }
    return { maxFrontier: max, anyLoading: loading };
  }, [slices]);

  const value = useMemo<DataFreshnessContextValue>(
    () => ({ maxFrontier, anyLoading, bySource: slices, fallbackVersion, report }),
    [maxFrontier, anyLoading, slices, fallbackVersion, report],
  );

  return (
    <DataFreshnessContext.Provider value={value}>{children}</DataFreshnessContext.Provider>
  );
}

/** Read the registry. Returns inert defaults + a no-op `report` when
 *  used outside the provider, so the reporting hooks are safe to mount
 *  in tests / storybook without the provider wrapper. */
export function useDataFreshness(): DataFreshnessContextValue {
  return useContext(DataFreshnessContext) ?? NO_PROVIDER_FALLBACK;
}

const NO_PROVIDER_FALLBACK: DataFreshnessContextValue = {
  maxFrontier: null,
  anyLoading: false,
  bySource: {},
  fallbackVersion: 0,
  report: () => {},
};
