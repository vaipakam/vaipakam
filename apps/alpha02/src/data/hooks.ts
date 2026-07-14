/**
 * react-query hooks over the indexer client.
 *
 * Loading contract every page relies on:
 *   - `data === undefined`  → still loading (show a spinner)
 *   - `data === null`       → indexer unavailable (show "couldn't load",
 *                             NEVER an empty-market message — that
 *                             distinction is what fixes the
 *                             "No Open Offers / 6 hidden" class of bug
 *                             from the 2026-07-02 naive-user audit)
 *   - `data === {...}`      → real result (empty arrays mean truly empty)
 */
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { useActiveChain } from '../chain/useActiveChain';
import {
  fetchActiveOffers,
  fetchIndexerFreshness,
  fetchLoanById,
  fetchLoansByBorrower,
  fetchLoansByLender,
  fetchOfferById,
  fetchOffersByCreator,
  fetchOffersByCurrentHolder,
  indexerConfigured,
  type IndexedLoan,
  type IndexedOffer,
  type IndexerFreshness,
} from './indexer';
import { readLoanRowLive } from './liveLoanRow';
import { scanTerminalOfferIds } from './bookCatchUp';
import {
  readOfferRowLive,
  readOwnLoanRowsLive,
  readOwnOfferRowsLive,
} from './chainPositions';
import { signalAware, tipAware } from '../chain/railHealth';

const REFRESH_MS = 30_000;

/** Open offers on the current read chain (both sides). One shared
 *  cache entry for every surface (Offer Book, guided flows, rentals).
 *  Follows the indexer's `nextBefore` cursor up to a page cap so a
 *  busy book doesn't falsely report "no matching offers" for offers
 *  sitting past the first page. */
const ACTIVE_OFFERS_PAGE = 100;
const ACTIVE_OFFERS_MAX_PAGES = 5;

/** The indexed walk's result — offers PLUS the freshness cursor that
 *  was snapshotted before the pages were fetched, so the ghost-strip
 *  query can scan from the exact same lower bound (§4.1.2a: an
 *  independent cursor read would re-open the mid-walk ingest race the
 *  snapshot exists to close). */
interface ActiveOffersWalk {
  offers: IndexedOffer[];
  freshness: IndexerFreshness | null;
}

export function useActiveOffers() {
  const { readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });

  const walk = useQuery({
    queryKey: ['activeOffers', readChain.chainId],
    // RPC read-diet PR A — push-covered root: 180s net while the
    // rail is healthy, today's idle-aware 30s otherwise (§4.1.1).
    refetchInterval: signalAware(REFRESH_MS),
    queryFn: async (): Promise<ActiveOffersWalk | null> => {
      // Freshness cursor snapshotted BEFORE the page walk: an ingest
      // landing mid-walk could advance the cursor past a terminal
      // block whose stale row is already collected, and the catch-up
      // scan would then skip exactly the window that row needs.
      const freshness = indexerConfigured()
        ? await fetchIndexerFreshness(readChain.chainId)
        : null;
      // ANY page failing (including later cursor pages) → unavailable,
      // and so does hitting the page cap with a cursor still open —
      // publishing a confident half-book would let guided matching say
      // "no matching offers" while the match sits on the missing page.
      const all: IndexedOffer[] = [];
      let before: number | undefined;
      for (let i = 0; i < ACTIVE_OFFERS_MAX_PAGES; i++) {
        const page = await fetchActiveOffers(readChain.chainId, {
          limit: ACTIVE_OFFERS_PAGE,
          before,
        });
        if (page === null) return null;
        all.push(...page.offers);
        if (page.nextBefore === null) break;
        before = page.nextBefore;
        if (i === ACTIVE_OFFERS_MAX_PAGES - 1) {
          return null; // cap reached with more pages remaining → truncated
        }
      }
      return { offers: all, freshness };
    },
  });

  // On-chain catch-up (#1029), split into its own block-driven query
  // (RPC read-diet PR A, §4.1.2a): the ghost-strip is the shared-book
  // honesty check (strip offers the chain already marked terminal in
  // the tail the indexer hasn't ingested yet), and it must keep tip
  // cadence even while the indexed walk above idles at the 180s net —
  // LiveChainSync tip-nudges the 'bookGhostStrip' root per block on WS
  // deploys. The scan's lower bound is the walk's SNAPSHOTTED cursor
  // (part of this key), never a fresh cursor read. Composed here, in
  // the shared hook, so every consumer (book, OfferFlow, Rent,
  // EarlyExit) gets only stripped rows. Fail-open: scan trouble yields
  // an empty set — the strip can make the book more honest, never
  // unavailable.
  const walkData = walk.data;
  const strip = useQuery({
    queryKey: [
      'bookGhostStrip',
      readChain.chainId,
      walkData?.freshness?.lastBlock ?? null,
    ],
    enabled:
      walkData != null &&
      walkData.freshness != null &&
      walkData.offers.length > 0 &&
      Boolean(publicClient),
    // Block-driven on WS deploys (tip nudge); on HTTP-only chains the
    // interval carries it at today's cadence, same as the pre-split
    // behaviour where the strip re-ran with each 30s walk refetch.
    refetchInterval: tipAware(REFRESH_MS, Boolean(readChain.wsUrl)),
    queryFn: () =>
      scanTerminalOfferIds({
        diamondAddress: readChain.diamondAddress,
        deployBlock: readChain.deployBlock,
        publicClient,
        freshness: walkData?.freshness ?? null,
      }).then((ids) => [...ids]),
  });

  // Compose. Contract preserved from the pre-split hook:
  //   undefined → loading (includes "walk done, FIRST strip for this
  //   snapshot still in flight" — the old code awaited the strip
  //   before publishing, and publishing unstripped rows here would
  //   flash exactly the ghost row the strip exists to remove);
  //   null → indexer unavailable; array → stripped rows.
  // A strip REFETCH keeps its previous data while in flight, so
  // block-driven re-runs never blank the book.
  const data = ((): IndexedOffer[] | null | undefined => {
    if (walkData === undefined) return undefined;
    if (walkData === null) return null;
    if (walkData.freshness == null || walkData.offers.length === 0) {
      return walkData.offers; // unknown cursor → unfiltered (unchanged)
    }
    if (strip.data === undefined) return undefined; // first scan in flight
    const terminal = new Set(strip.data);
    return walkData.offers.filter((o) => !terminal.has(o.offerId));
  })();

  return { ...walk, data };
}

export interface PositionLoan extends IndexedLoan {
  role: 'lender' | 'borrower';
}

const MY_PAGES_MAX = 5;

/** Follow a cursor-paginated fetcher to exhaustion (page cap as a
 *  runaway bound). Returns null on ANY page failure — a partial list
 *  rendered as complete is exactly the dishonesty the null contract
 *  exists to prevent. */
export async function fetchAllPages<T>(
  fetchPage: (
    before: number | undefined,
  ) => Promise<{ rows: T[]; nextBefore: number | null } | null>,
): Promise<T[] | null> {
  const all: T[] = [];
  let before: number | undefined;
  for (let i = 0; i < MY_PAGES_MAX; i++) {
    const page = await fetchPage(before);
    if (page === null) return null;
    all.push(...page.rows);
    if (page.nextBefore === null) return all;
    before = page.nextBefore;
  }
  return null; // cap hit with a cursor still open — truncated ≠ complete
}

/** Result of the two-source read behind the positions hooks.
 *
 *  MERGE RULE — the chain leg, when it answers, is the SOLE row
 *  source: it enumerates everything the wallet is currently involved
 *  in (created offers, held offer NFTs, held loan positions) live
 *  this block, so any indexed row outside it is either an ingest-lag
 *  ghost (just-cancelled offer, transferred/burned position) or a
 *  position the wallet no longer holds — merging those back in is
 *  exactly how ghosts survive. The indexed lists serve ONLY as the
 *  fallback when the chain leg is unavailable (their pre-existing
 *  role) — plus the one leg the chain itself reports it could not
 *  enumerate (see OwnOfferRead.heldLegOk for legacy deploys without
 *  a holder view). The flags say which source answered: Positions shows a
 *  degraded-sources note when either is false; Activity refuses to
 *  run its participation filter without the indexer leg. NOTE the
 *  indexer's /loans/by-* routes are CURRENT-OWNER filtered (no
 *  burned-NFT history), so `indexerOk` is redundancy-leg
 *  availability — not a history promise. */
export interface MyRows<T> {
  rows: T[];
  chainOk: boolean;
  indexerOk: boolean;
}

/** Loans variant of {@link MyRows}: also carries the loan ids the
 *  INDEXED leg returned (empty when that leg failed). Activity's
 *  participation filter needs the UNION of both legs — `rows` is
 *  chain-sole-source when the chain answers, which by design drops
 *  positions whose NFTs were burned/transferred away, yet actor-null
 *  events (LoanSettled, keeper LoanDefaulted) for exactly those loans
 *  still belong in the wallet's feed. SCOPE: the indexed by-* routes
 *  are themselves current-owner filtered, so these ids cover the
 *  ingest-LAG window after a burn/transfer, not permanent history —
 *  a true historical-participant route is tracked as #1023. */
export interface MyLoanRows extends MyRows<PositionLoan> {
  indexedLoanIds: number[];
}

async function fetchIndexedLoans(
  chainId: number,
  address: string,
): Promise<PositionLoan[] | null> {
  const [asLender, asBorrower] = await Promise.all([
    fetchAllPages<IndexedLoan>((before) =>
      fetchLoansByLender(chainId, address, { limit: 100, before }).then(
        (p) => (p === null ? null : { rows: p.loans, nextBefore: p.nextBefore }),
      ),
    ),
    fetchAllPages<IndexedLoan>((before) =>
      fetchLoansByBorrower(chainId, address, { limit: 100, before }).then(
        (p) => (p === null ? null : { rows: p.loans, nextBefore: p.nextBefore }),
      ),
    ),
  ]);
  // EITHER side failing means the list would be silently partial —
  // that's "unavailable", never a confident half-answer.
  if (asLender === null || asBorrower === null) return null;
  return [
    ...asLender.map((l) => ({ ...l, role: 'lender' as const })),
    ...asBorrower.map((l) => ({ ...l, role: 'borrower' as const })),
  ];
}

/** Every loan where the connected wallet is lender or borrower,
 *  newest first, with the completeness flag. CHAIN-AUTHORITATIVE for
 *  currently-held positions (visible within a block of the tx — the
 *  indexer's cron ingest lags 30–60s); the indexer contributes the
 *  history the chain can't enumerate. `data === null` only when BOTH
 *  sources are unavailable. */
export function useMyLoansFull() {
  const { readChain, address } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  return useQuery({
    queryKey: ['myLoans', readChain.chainId, address?.toLowerCase()],
    enabled: Boolean(address),
    // RPC read-diet PR A — list root, deliberately NOT tip-nudged
    // (§4.1.2): push + receipt + focus + 180s net carry it.
    refetchInterval: signalAware(REFRESH_MS),
    queryFn: async (): Promise<MyLoanRows | null> => {
      if (!address)
        return { rows: [], chainOk: true, indexerOk: true, indexedLoanIds: [] };
      const [chainRows, indexedRows] = await Promise.all([
        publicClient
          ? readOwnLoanRowsLive(
              publicClient,
              readChain.diamondAddress,
              readChain.chainId,
              address,
            )
          : Promise.resolve(null),
        fetchIndexedLoans(readChain.chainId, address),
      ]);
      if (chainRows === null && indexedRows === null) return null;
      // See MyRows: the live enumeration, when it answers, is the
      // sole source — an indexed row absent from it is a ghost
      // (transferred/burned position) or no longer the wallet's,
      // regardless of status. Indexed rows serve only as the
      // fallback when the chain leg is unavailable — but their ids
      // still ride along (see MyLoanRows) for Activity's
      // participation filter.
      const rows = [...(chainRows ?? indexedRows ?? [])].sort(
        (a, b) => b.startAt - a.startAt,
      );
      return {
        rows,
        chainOk: chainRows !== null,
        indexerOk: indexedRows !== null,
        indexedLoanIds: (indexedRows ?? []).map((l) => l.loanId),
      };
    },
  });
}

/** Slim view of {@link useMyLoansFull} — same cache entry, rows only.
 *  For consumers that don't render source-degradation (Home, vault,
 *  claimables — each already tolerates a missing source or does its
 *  own authoritative confirms). Activity uses the FULL variant: its
 *  participation filter needs the indexer leg. */
export function useMyLoans() {
  const full = useMyLoansFull();
  return {
    ...full,
    data:
      full.data === undefined ? undefined : full.data === null ? null : full.data.rows,
  };
}

/** One offer by id on the read chain (deep-link target from the
 *  Offer Book's "Use this offer" action). */
export function useOffer(offerId: number | undefined) {
  const { readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  return useQuery({
    queryKey: ['offer', readChain.chainId, offerId],
    enabled: offerId !== undefined && Number.isFinite(offerId),
    // RPC read-diet PR A — detail-page action root: stretches only
    // when BOTH rails cover it (indexer push healthy + chain WS tip
    // nudge); on an HTTP-only chain deploy it keeps todays 30s.
    refetchInterval: tipAware(REFRESH_MS, Boolean(readChain.wsUrl)),
    queryFn: async (): Promise<IndexedOffer | null> => {
      const row = await fetchOfferById(readChain.chainId, offerId!);
      if (row) return row;
      // Indexer miss (ingest lag on a just-posted offer, or indexer
      // down) — fall back to the live chain read so a shared
      // ?offer= deep link works the moment the tx mines instead of
      // "couldn't find that offer" for the length of the ingest
      // window (#1042; live-repro'd during the #1035 verification).
      // Same pattern as useLoan: a revert (no such offer) keeps the
      // not-found verdict, transport failure keeps "unavailable".
      if (!publicClient) return null;
      try {
        return await readOfferRowLive(
          publicClient,
          readChain.diamondAddress,
          readChain.chainId,
          offerId!,
        );
      } catch {
        return null;
      }
    },
  });
}

/** One loan by id on the read chain. */
export function useLoan(loanId: number | undefined) {
  const { readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  return useQuery({
    queryKey: ['loan', readChain.chainId, loanId],
    enabled: loanId !== undefined && Number.isFinite(loanId),
    // RPC read-diet PR A — detail-page action root (see useOffer).
    refetchInterval: tipAware(REFRESH_MS, Boolean(readChain.wsUrl)),
    queryFn: async (): Promise<IndexedLoan | null> => {
      const row = await fetchLoanById(readChain.chainId, loanId!);
      if (row) return row;
      // Indexer miss (lag on a brand-new loan, or indexer down) — fall
      // back to the live chain read so the detail page a chain-only
      // Claim Center entry deep-links to actually renders (#982
      // review). A revert (no such loan) or transport failure keeps
      // the indexer verdict: null = unavailable/not found.
      if (!publicClient) return null;
      try {
        return await readLoanRowLive(
          publicClient,
          readChain.diamondAddress,
          readChain.chainId,
          loanId!,
        );
      } catch {
        return null;
      }
    },
  });
}

/** Open offers the wallet is involved in: UNION of offers it CREATED
 *  (cancelOffer authorizes only the creator until expiry —
 *  OfferCancelFacet #195) and offers whose position NFT it currently
 *  HOLDS (visibility for secondary-market recipients). The UI keys
 *  the cancel action on `offer.creator === wallet`.
 *
 *  CHAIN-AUTHORITATIVE for created AND held offers (a fresh
 *  createOffer shows within a block — the indexer's cron ingest lags
 *  30–60s). On older deploys without any holder view, the chain
 *  helper says so (`heldLegOk === false`) and the indexed
 *  by-current-holder rows are kept for that leg — never hidden
 *  behind a chain result that couldn't see them. `data === null`
 *  only when BOTH sources fail. */
export function useMyOffersFull() {
  const { readChain, address } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  return useQuery({
    queryKey: ['myOffers', readChain.chainId, address?.toLowerCase()],
    enabled: Boolean(address),
    // RPC read-diet PR A — list root (see useMyLoansFull). The
    // cancel/amend rows rendered straight from this list get a
    // blocking click-time preflight instead of tip freshness (§4.1.2).
    refetchInterval: signalAware(REFRESH_MS),
    queryFn: async (): Promise<MyRows<IndexedOffer> | null> => {
      if (!address) return { rows: [], chainOk: true, indexerOk: true };
      const [chainLive, created, held] = await Promise.all([
        publicClient
          ? readOwnOfferRowsLive(
              publicClient,
              readChain.diamondAddress,
              readChain.chainId,
              address,
            )
          : Promise.resolve(null),
        fetchAllPages<IndexedOffer>((before) =>
          fetchOffersByCreator(readChain.chainId, address, {
            limit: 100,
            before,
          }).then((p) =>
            p === null ? null : { rows: p.offers, nextBefore: p.nextBefore },
          ),
        ),
        fetchAllPages<IndexedOffer>((before) =>
          fetchOffersByCurrentHolder(readChain.chainId, address, {
            limit: 100,
            before,
          }).then((p) =>
            p === null ? null : { rows: p.offers, nextBefore: p.nextBefore },
          ),
        ),
      ]);
      const indexerOk = created !== null && held !== null;
      if (chainLive === null && !indexerOk) return null;
      // See MyRows: chain leg is the sole source when it answers —
      // it covers created AND held offers, and a cancelled offer
      // simply isn't in it (no tombstone bookkeeping needed, and no
      // stale indexed "active" row can resurrect one). Indexed rows
      // only serve as the fallback when the chain leg is down — with
      // ONE carve-out: on deploys where no holder view exists
      // (heldLegOk false), the chain result genuinely couldn't see
      // held-via-transfer listings, so the indexed by-current-holder
      // rows are kept for that leg rather than discarded.
      const source =
        chainLive === null
          ? indexerOk
            ? [...created, ...held]
            : []
          : chainLive.heldLegOk
            ? chainLive.rows
            : [...chainLive.rows, ...(held ?? [])];
      const seen = new Set<number>();
      const rows = source.filter((o) => {
        if (o.status !== 'active' || seen.has(o.offerId)) return false;
        seen.add(o.offerId);
        return true;
      });
      // The contract enumeration is append-ordered (oldest first) —
      // sort newest-first so a freshly posted offer tops the list,
      // matching the indexed routes' offer_id DESC ordering.
      rows.sort((a, b) => b.offerId - a.offerId);
      // chainOk demands BOTH chain legs: on legacy deploys without a
      // holder view (heldLegOk false) the held leg is indexer-only,
      // so a freshly transferred listing can lag — the degraded-
      // sources banner must say so rather than pass as fully live.
      return {
        rows,
        chainOk: chainLive !== null && chainLive.heldLegOk,
        indexerOk,
      };
    },
  });
}

/** Slim view of {@link useMyOffersFull} — rows only. */
export function useMyOffers() {
  const full = useMyOffersFull();
  return {
    ...full,
    data:
      full.data === undefined ? undefined : full.data === null ? null : full.data.rows,
  };
}

// `useMyClaimables` now lives in `./claimables` and is on-chain-
// authoritative (issue #921 item 7 / #958): the indexer stays the fast
// candidate layer via `useMyLoans`, and `getClaimable` is the authority.
// Imported directly from `./claimables` by call sites (one-way dep, no
// cycle with this module).
