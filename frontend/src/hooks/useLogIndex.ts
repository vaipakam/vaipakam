import { useCallback, useEffect, useRef, useState } from 'react';
import type { Address } from 'viem';
import { useDiamondPublicClient, useReadChain } from '../contracts/useDiamond';
import { DEFAULT_CHAIN } from '../contracts/config';
import { DIAMOND_ABI_VIEM } from '../contracts/abis';
import {
  loadLoanIndex,
  peekLoanIndex,
  type LoanIndexEntry,
  type ActivityEvent,
} from '../lib/logIndex';
import { useOfferStats } from './useOfferStats';

/** Tier 2 #22 — events that can change the offer-book set; any of them
 *  firing on-chain triggers a debounced incremental rescan so the
 *  offer book + dashboard reflect the new state without the user
 *  hitting "Rescan chain" by hand. The list intentionally covers
 *  *both* sides of the matching surface (`OfferAccepted` from
 *  `acceptOffer`, `OfferMatched` from `matchOffers`) so range-order
 *  partial fills don't slip through. */
const OFFER_BOOK_EVENTS = [
  'OfferCreated',
  'OfferAccepted',
  'OfferCanceled',
  'OfferMatched',
] as const;

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
  const { stats: offerStats } = useOfferStats();
  const indexerLastBlock = offerStats?.indexer?.lastBlock;
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
    load();
  }, [load]);

  // Tier 2 #22 — auto-refresh the index when any offer-book-affecting
  // event fires on-chain. Without this, a freshly created offer (or a
  // freshly matched / cancelled one) doesn't appear in the offer book
  // until the user reloads the page or clicks "Rescan chain". The
  // underlying scan is incremental (only blocks past `lastBlock`), so
  // the cost per trigger is small.
  //
  // Debounce: a single user action can emit multiple events in the
  // same tx (a `matchOffers` call emits both `OfferAccepted` and
  // `OfferMatched`, plus optionally a dust-close `OfferCanceled`).
  // Coalesce them into one rescan ~750ms after the last log lands.
  const publicClient = useDiamondPublicClient();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!publicClient || !diamondAddress) return;
    const scheduleReload = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        void load();
      }, 750);
    };
    const unwatchers = OFFER_BOOK_EVENTS.map((eventName) =>
      publicClient.watchContractEvent({
        address: diamondAddress as Address,
        abi: DIAMOND_ABI_VIEM,
        eventName,
        onLogs: scheduleReload,
        // Suppress noisy onError logs — public RPCs sometimes drop the
        // filter and viem retries internally; we don't need to show
        // anything to the user.
        onError: () => {},
      }),
    );
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      for (const unwatch of unwatchers) unwatch();
    };
  }, [publicClient, diamondAddress, load]);

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
