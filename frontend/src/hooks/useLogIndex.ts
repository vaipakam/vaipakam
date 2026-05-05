import { useCallback, useEffect, useState } from 'react';
import { useReadChain } from '../contracts/useDiamond';
import { DEFAULT_CHAIN } from '../contracts/config';
import {
  loadLoanIndex,
  peekLoanIndex,
  type LoanIndexEntry,
  type ActivityEvent,
} from '../lib/logIndex';
import { useOfferStats } from './useOfferStats';
import { useLiveWatermark } from './useLiveWatermark';

type LoanInitiatedForToken = {
  loanId: string;
  role: 'lender' | 'borrower';
  event: ActivityEvent;
};
import { beginStep } from '../lib/journeyLog';

/**
 * Shared event-backed loan index. `useUserLoans` and `useClaimables` both
 * consume this instead of linearly probing `getLoanDetails(1..N)`, and
 * both use the `getOwner` lookup to skip live `ownerOf` round-trips for
 * loans whose NFTs haven't moved since the last scan.
 */
export function useLogIndex() {
  const chain = useReadChain();
  const chainId = chain.chainId ?? DEFAULT_CHAIN.chainId;
  const diamondAddress = chain.diamondAddress ?? DEFAULT_CHAIN.diamondAddress;
  const rpcUrl = chain.rpcUrl ?? DEFAULT_CHAIN.rpcUrl;
  // The worker stats endpoint exposes `indexer.lastBlock` — when set,
  // we hand it to `loadLoanIndex` so the local log scan fast-forwards
  // past everything the indexer already covered. When the worker is
  // unreachable, `stats` is null and the hint is `undefined`,
  // collapsing to the legacy local-cache-cursor behaviour.
  //
  // `statsResolved` gates the initial scan: until `useOfferStats` has
  // returned its first response (success or null-on-failure), we
  // don't fire the scan at all. This avoids the page-load race where
  // `load()` would otherwise run synchronously on first render with
  // `indexerLastBlock = undefined`, falling through to a full
  // deployBlock → head scan (hundreds of thousands of blocks on a
  // mature chain). Once stats resolve, the scan starts at
  // `max(cached.lastBlock+1, indexer.lastBlock+1)` — typically a ~60 s
  // catch-up window, not the entire history. localStorage's cached
  // snapshot is still rendered synchronously for first-paint via
  // `peekLoanIndex` regardless of the gate, so users see content
  // immediately.
  const { stats: offerStats, loading: statsLoading } = useOfferStats();
  const statsResolved = !statsLoading;
  const indexerLastBlock = offerStats?.indexer?.lastBlock;
  // The shared 5 s watermark probe — `version` bumps every time
  // `nextOfferId` or `nextLoanId` advances on-chain. Subscribing here
  // unifies the refetch trigger with the indexer-driven hooks: a
  // single probe drives both the indexer-served data hooks AND the
  // legacy log-scan refresh, replacing the per-event
  // `watchContractEvent` watcher we used to keep alive (which was
  // running an `eth_newFilter` / `eth_getFilterChanges` poll loop in
  // the background even when the page was idle). Cancels and
  // partial-fills don't advance the watermark counters; those are
  // covered by tab-focus probe + post-tx-receipt refetch + the
  // explicit Rescan button.
  const { version: watermarkVersion } = useLiveWatermark();
  // Synchronous first-paint: hydrate whatever the last scan left in
  // localStorage, so Dashboard's "Your Loans" renders instantly on return
  // visits instead of blocking on a fresh `eth_getLogs` paginated scan
  // (which on a slow public RPC like Sepolia's default stalled the page
  // for tens of seconds even when the cache was fully populated).
  const initial = peekLoanIndex(chainId, diamondAddress);
  const [loans, setLoans] = useState<LoanIndexEntry[]>(initial?.loans ?? []);
  const [offerIds, setOfferIds] = useState<bigint[]>(initial?.offerIds ?? []);
  const [openOfferIds, setOpenOfferIds] = useState<bigint[]>(initial?.openOfferIds ?? []);
  const [closedOfferIds, setClosedOfferIds] = useState<bigint[]>(initial?.closedOfferIds ?? []);
  const [lastAcceptedOfferId, setLastAcceptedOfferId] = useState<bigint | null>(
    initial?.lastAcceptedOfferId ?? null,
  );
  const [recentAcceptedOfferIds, setRecentAcceptedOfferIds] = useState<bigint[]>(
    initial?.recentAcceptedOfferIds ?? [],
  );
  const [events, setEvents] = useState<ActivityEvent[]>(initial?.events ?? []);
  const [getOwner, setGetOwner] = useState<(id: bigint) => string | null>(
    () => initial?.getOwner ?? (() => null),
  );
  const [getLastOwner, setGetLastOwner] = useState<(id: bigint) => string | null>(
    () => initial?.getLastOwner ?? (() => null),
  );
  const [getLoanInitiatedForToken, setGetLoanInitiatedForToken] = useState<
    (id: bigint) => LoanInitiatedForToken | null
  >(() => initial?.getLoanInitiatedForToken ?? (() => null));
  // Only show a blocking "loading" state when we have no cached data at all.
  // When a cache snapshot exists we render it immediately and let the
  // background scan refresh state silently.
  const [loading, setLoading] = useState(initial === null);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(async () => {
    const peeked = peekLoanIndex(chainId, diamondAddress);
    if (peeked === null) {
      setLoading(true);
    } else {
      // Apply the peek even if it matches initial state — chainId /
      // diamondAddress may have changed since mount.
      setLoans(peeked.loans);
      setOfferIds(peeked.offerIds);
      setOpenOfferIds(peeked.openOfferIds);
      setClosedOfferIds(peeked.closedOfferIds);
      setLastAcceptedOfferId(peeked.lastAcceptedOfferId);
      setRecentAcceptedOfferIds(peeked.recentAcceptedOfferIds);
      setEvents(peeked.events);
      setGetOwner(() => peeked.getOwner);
      setGetLastOwner(() => peeked.getLastOwner);
      setGetLoanInitiatedForToken(() => peeked.getLoanInitiatedForToken);
      setLoading(false);
    }
    setError(null);
    const step = beginStep({ area: 'log-index', flow: 'loadLoanIndex', step: 'scan-events' });
    try {
      const result = await loadLoanIndex(
        rpcUrl,
        diamondAddress,
        chain.deployBlock ?? DEFAULT_CHAIN.deployBlock,
        chainId,
        indexerLastBlock,
      );
      setLoans(result.loans);
      setOfferIds(result.offerIds);
      setOpenOfferIds(result.openOfferIds);
      setClosedOfferIds(result.closedOfferIds);
      setLastAcceptedOfferId(result.lastAcceptedOfferId);
      setRecentAcceptedOfferIds(result.recentAcceptedOfferIds);
      setEvents(result.events);
      // Wrap in a thunk so React treats it as a state updater argument,
      // not a reducer-style setter.
      setGetOwner(() => result.getOwner);
      setGetLastOwner(() => result.getLastOwner);
      setGetLoanInitiatedForToken(() => result.getLoanInitiatedForToken);
      step.success({ note: `${result.loans.length} loans indexed` });
    } catch (e) {
      setError(e as Error);
      step.failure(e);
    } finally {
      setLoading(false);
    }
  }, [rpcUrl, diamondAddress, chain.deployBlock, chainId, indexerLastBlock]);

  useEffect(() => {
    // Wait for the indexer-stats fetch to resolve (success or
    // null-on-failure) before kicking off the on-chain scan. The
    // initial mount, every tab-focus refetch, and every watermark
    // version bump (= someone created an offer or a loan landed)
    // all flow through this single effect. Mirrors the rescan
    // button's behaviour: indexer-snapshot first, RPC delta on top.
    //
    // `watermarkVersion` is in the dep array so the legacy log scan
    // re-runs when the live-tail watermark detects on-chain change.
    // This replaces the prior per-event `watchContractEvent` watcher
    // that kept an `eth_getFilterChanges` poll loop alive in the
    // background — the watermark is a strict superset (covers
    // creates) and is shared with the indexer-driven hooks, so we
    // avoid duplicating the polling channel.
    if (!statsResolved) return;
    void load();
  }, [load, statsResolved, watermarkVersion]);

  return {
    loans,
    offerIds,
    openOfferIds,
    closedOfferIds,
    lastAcceptedOfferId,
    recentAcceptedOfferIds,
    events,
    getOwner,
    getLastOwner,
    getLoanInitiatedForToken,
    loading,
    error,
    reload: load,
  };
}
