/**
 * Data-freshness registry — the context object, its value type, and the
 * consumer hook.
 *
 * Split out of `DataFreshnessContext.tsx` so that file exports a component
 * and nothing else. A module mixing a component with plain values defeats
 * Fast Refresh: editing the provider forces a full reload rather than a
 * hot swap, because the bundler cannot prove the non-component exports are
 * unchanged. The provider itself, and the trigger logic it owns, stay in
 * the `.tsx`.
 *
 * See `DataFreshnessContext.tsx` for what the registry is FOR.
 */
import { createContext, useContext } from 'react';

/** Stable keys for the known reporters. Add one here when wiring a new
 *  data hook into the registry. */
export type FreshnessSource =
  | 'offerStats' // useOfferStats — reports the central indexer's lastBlock + loading
  | 'activeOffers' // useIndexedActiveOffers — RPC tail-scan frontier + loading
  | 'activeLoans' // useIndexedActiveLoans — RPC tail-scan frontier + loading
  | 'roleLoans' // useIndexedRoleLoans (lender/borrower) — RPC tail-scan frontier + loading
  | 'userLoans' // useUserLoans — on-chain view + multicall; loading only (reads at latest)
  | 'logIndex'; // useLogIndex — legacy log scan; loading only

export interface SourceSlice {
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

export interface DataFreshnessContextValue {
  /** Max `frontier` over all sources that report one, or `null` if
   *  none has reported a frontier yet on this chain. */
  maxFrontier: number | null;
  /** OR of every source's `loading` flag — true while any registered
   *  data fetch is in flight. */
  anyLoading: boolean;
  /** Per-source breakdown — drives the badge popover's detail rows. */
  bySource: Readonly<Record<string, SourceSlice>>;
  /** Counter that bumps when the indexer-fallback trigger fires (see
   *  `DataFreshnessContext.tsx`). Tail-scan hooks include this in their
   *  effect dep array to refetch when the indexer can't keep them fresh. */
  fallbackVersion: number;
  /** A source updates its slice. Pass only the fields that changed.
   *  `frontier` is clamped monotonic-forward within a chain; `loading`
   *  is set/cleared freely. */
  report: (source: FreshnessSource, patch: SourceSlice) => void;
}

export const DataFreshnessContext = createContext<DataFreshnessContextValue | null>(null);

const NO_PROVIDER_FALLBACK: DataFreshnessContextValue = {
  maxFrontier: null,
  anyLoading: false,
  bySource: {},
  fallbackVersion: 0,
  report: () => {},
};

/** Read the registry. Returns inert defaults + a no-op `report` when
 *  used outside the provider, so the reporting hooks are safe to mount
 *  in tests / storybook without the provider wrapper. */
export function useDataFreshness(): DataFreshnessContextValue {
  return useContext(DataFreshnessContext) ?? NO_PROVIDER_FALLBACK;
}
