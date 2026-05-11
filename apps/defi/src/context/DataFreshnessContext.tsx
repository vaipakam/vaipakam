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
  /** A source updates its slice. Pass only the fields that changed.
   *  `frontier` is clamped monotonic-forward within a chain; `loading`
   *  is set/cleared freely. */
  report: (source: FreshnessSource, patch: SourceSlice) => void;
}

const DataFreshnessContext = createContext<DataFreshnessContextValue | null>(null);

export function DataFreshnessProvider({ children }: { children: ReactNode }) {
  const chain = useReadChain();
  const chainId = chain.chainId;

  const slicesRef = useRef<Record<string, SourceSlice>>({});
  const [slices, setSlices] = useState<Record<string, SourceSlice>>({});

  useEffect(() => {
    // Chain switch (or first mount): drop everything. A stale higher
    // frontier from the prior chain would make the badge claim
    // freshness it doesn't have on the new chain.
    slicesRef.current = {};
    setSlices({});
  }, [chainId]);

  const report = useCallback((source: FreshnessSource, patch: SourceSlice) => {
    const prev = slicesRef.current[source] ?? {};
    const next: SourceSlice = { ...prev };
    let changed = false;

    if (patch.frontier !== undefined) {
      const n = Number(patch.frontier);
      if (Number.isFinite(n) && n > 0 && n > (prev.frontier ?? 0)) {
        next.frontier = n;
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
    () => ({ maxFrontier, anyLoading, bySource: slices, report }),
    [maxFrontier, anyLoading, slices, report],
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
  report: () => {},
};
