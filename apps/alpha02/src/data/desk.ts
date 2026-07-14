/**
 * Rate Desk data layer (#1129 phase 1).
 *
 * Three market-scoped reads, all on the app's tri-state honesty
 * contract (`undefined` = loading, `null` = unavailable, value =
 * real answer — empty arrays mean truly empty):
 *
 *  - `useDeskMarkets` — the indexer's `/offers/markets` summary
 *    (distinct ERC-20/ERC-20 (pair, tenor) triples with live counts +
 *    best rates). Drives the pair chips + tenor emphasis; the desk
 *    NEVER derives markets from walking the paginated active feed.
 *  - `useDeskBook` — the order book for one pair. Two-step CHAIN read
 *    first (`getActiveOffersByAssetPairRanked` for ids, then
 *    `getOffersWithState` hydration chunked at ≤250 — the skinny
 *    ranking DTO omits `amountFilled`, so remaining depth needs the
 *    hydration); falls back to the indexer's market-scoped
 *    `/offers/active` when the RPC read fails.
 *  - `useDeskTape` — executed fills for the (pair, tenor) market via
 *    the market-scoped `/loans/recent` with sale vehicles excluded
 *    (a secondary position sale is not a fresh rate print).
 *
 * Plus the pure ladder math (`buildLadder`): tenor slice, lazy-GTT
 * expiry drop, ERC-20-only, remaining-size depth (never headline
 * size), per-rate aggregation with cumulative sums.
 */
import { useMemo } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { erc20Abi, type PublicClient } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { useActiveChain } from '../chain/useActiveChain';
import { idleAware } from '../lib/idle';
import { signalAware, tipAware } from '../chain/railHealth';
import { AssetType } from '../lib/types';
import {
  fetchActiveOffers,
  fetchLoansByParticipant,
  fetchOffersMarkets,
  fetchRateCandles,
  fetchRecentLoans,
  fetchSignedOffers,
  indexerConfigured,
  type CandleInterval,
  type CandleRange,
  type IndexedLoan,
  type IndexedOffer,
  type IndexedParticipantLoan,
  type IndexedSignedOffer,
  type MarketSummary,
  type RateCandleBucket,
} from './indexer';
import {
  signedOrderIsSingleValue,
  type DeskBookRow,
} from '../lib/signedOffer';
import { readOfferRowsBatchLive } from './chainPositions';
import { isMissingSelectorError } from '../contracts/preflights';

const REFRESH_MS = 30_000;
/** Indexer-fallback page walk bound — same shape as useActiveOffers'
 *  cap: hitting it with a cursor still open returns null (truncated
 *  ≠ complete), never a confident half-book. */
const BOOK_FALLBACK_PAGES = 5;
/** Tape page-walk bound — only ever consumed against an OLDER worker
 *  that ignored the market params and served the global feed (a
 *  market-scoping worker answers the tape in its first page). */
const TAPE_FALLBACK_PAGES = 5;

export interface DeskPair {
  lendingAsset: string;
  collateralAsset: string;
}

export function pairKey(pair: DeskPair): string {
  return `${pair.lendingAsset.toLowerCase()}:${pair.collateralAsset.toLowerCase()}`;
}

/** Markets summary for the read chain. `null` = indexer unavailable
 *  (the header shows an honest "markets list unavailable" state and
 *  falls back to the selected pair's book for tenor emphasis). */
export function useDeskMarkets() {
  const { readChain } = useActiveChain();
  return useQuery({
    queryKey: ['deskMarkets', readChain.chainId],
    // RPC read-diet PR A (Codex #1228 r1) — markets can exist purely from
    // gasless signed depth, which never pushes; keep today's cadence.
    refetchInterval: idleAware(REFRESH_MS),
    queryFn: async (): Promise<MarketSummary[] | null> => {
      if (!indexerConfigured()) return null;
      const res = await fetchOffersMarkets(readChain.chainId);
      return res === null ? null : res.markets;
    },
  });
}

/** Offer ids among `rows` that are LINKED VEHICLES: offers bound to an
 *  existing loan (`getOfferLinkedLoanId != 0`). That covers BOTH
 *  shapes — borrower-style lender-sale vehicles (`saleOfferToLoanId`)
 *  AND lender-style Preclose Option-3 offset vehicles
 *  (`offsetOfferToLoanId`, Codex #1134 round-4 P3). Both are
 *  bookkeeping pinned to a live loan, not fresh market liquidity, and
 *  OfferMutateFacet freezes both (`SaleVehicleImmutable` /
 *  `OffsetVehicleImmutable`), so every row handed in is probed — the
 *  CALLER decides the candidate set. The same-tick reads fold into
 *  ONE JSON-RPC batch (the transports use `batch: true`). Shared by
 *  the desk book and the Open orders panel so the two surfaces can't
 *  drift on the rule. */
export async function readLinkedOfferIds(
  publicClient: PublicClient,
  diamondAddress: `0x${string}`,
  rows: readonly IndexedOffer[],
): Promise<Set<number>> {
  const linkedLoanIds = await Promise.all(
    rows.map(
      (r) =>
        publicClient.readContract({
          address: diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getOfferLinkedLoanId',
          args: [BigInt(r.offerId)],
        }) as Promise<bigint>,
    ),
  );
  return new Set(
    rows.filter((_, i) => linkedLoanIds[i] !== 0n).map((r) => r.offerId),
  );
}

export interface DeskBook {
  /** Live rows for the pair. Chain-sourced books carry EVERY tenor
   *  (the ladder slices to the selected tenor; the full set drives
   *  tenor-emphasis fallback). The indexer fallback is scoped to the
   *  SELECTED tenor server-side — a busy pair's other tenors must not
   *  eat the page cap and blank a small market. */
  rows: IndexedOffer[];
  /** Which source answered — the ladder shows an honesty note when
   *  the book is the indexed copy (can lag the chain). */
  source: 'chain' | 'indexer';
}

/** The order book for one pair. Chain-first (ranked ids + chunked
 *  hydration), indexer fallback, `null` when both fail.
 *  `durationDays` scopes the FALLBACK only (the chain read is already
 *  pair-complete in two calls); it sits in the query key, so a tenor
 *  switch refetches — the cost of keeping the fallback honest. */
export function useDeskBook(pair: DeskPair | null, durationDays: number) {
  const { readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  return useQuery({
    queryKey: [
      'deskBook',
      readChain.chainId,
      pair ? pairKey(pair) : null,
      durationDays,
    ],
    enabled: pair !== null,
    // RPC read-diet PR A (Codex #1228 r1) — GTT expiry is TIME-based (no
    // push frame fires when expiresAt passes); the 30s interval is the
    // bound on how long an expired row can stay in the ladder.
    refetchInterval: idleAware(REFRESH_MS),
    queryFn: async (): Promise<DeskBook | null> => {
      // Chain leg — authoritative and fresh this block.
      if (publicClient) {
        try {
          const [rankings] = (await publicClient.readContract({
            address: readChain.diamondAddress,
            abi: DIAMOND_ABI_VIEM,
            functionName: 'getActiveOffersByAssetPairRanked',
            args: [
              pair!.lendingAsset as `0x${string}`,
              pair!.collateralAsset as `0x${string}`,
            ],
          })) as readonly [readonly { id: bigint }[], bigint];
          const ids = rankings.map((r) => Number(r.id));
          // Hydration is chunked at MAX_BATCH_IDS (250) inside the
          // helper; it also maps the canonical OfferState and applies
          // the lazy-GTT expiry overlay (expired rows leave 'active').
          const rows = await readOfferRowsBatchLive(
            publicClient,
            readChain.diamondAddress,
            readChain.chainId,
            ids,
          );
          const active = rows.filter((r) => r.status === 'active');
          // Linked vehicles are bookkeeping, not quotable liquidity —
          // borrower-style lender-sale vehicles as bids AND lender-
          // style Preclose Option-3 offset vehicles as asks (both DO
          // land in the ranked pair bucket: creation runs the normal
          // createOffer path before the link is written). Rendering
          // one would arm a taker affordance on a row whose terms are
          // pinned to an existing loan. One extra JSON-RPC batch per
          // book load (see readLinkedOfferIds). The indexer fallback
          // below filters both on the worker's `isSaleVehicle` /
          // `isOffsetVehicle` flags (migrations 0029 + 0031).
          const linkedIds = await readLinkedOfferIds(
            publicClient,
            readChain.diamondAddress,
            active,
          );
          return {
            rows: active.filter((r) => !linkedIds.has(r.offerId)),
            source: 'chain',
          };
        } catch {
          // fall through to the indexer copy
        }
      }
      // Indexer fallback — market-scoped server-side (the global page
      // cap can't honestly serve a per-market book). Scoped to the
      // SELECTED tenor too: walking every tenor for a busy pair can
      // exhaust the page cap and blank a small market (Codex #1134
      // round-2 P3).
      if (!indexerConfigured()) return null;
      const all: IndexedOffer[] = [];
      const wantLending = pair!.lendingAsset.toLowerCase();
      const wantCollateral = pair!.collateralAsset.toLowerCase();
      let before: number | undefined;
      for (let i = 0; i < BOOK_FALLBACK_PAGES; i++) {
        const page = await fetchActiveOffers(readChain.chainId, {
          limit: 100,
          before,
          lendingAsset: pair!.lendingAsset,
          collateralAsset: pair!.collateralAsset,
          durationDays,
          // Codex #1134 round-3 + round-5 — drop non-book rows
          // SERVER-side so lazily-expired GTT rows and sale/offset
          // vehicles can't eat the bounded page budget and truncate a
          // busy market's book.
          excludeExpired: true,
          excludeSaleVehicles: true,
          excludeOffsetVehicles: true,
        });
        if (page === null) return null;
        // Belt-and-suspenders client-side filters (an older worker
        // ignores unknown params — Codex #1134 round-4 P2: it may
        // return the GLOBAL feed, and buildLadder filters only
        // status/asset-type/tenor, so same-tenor rows from OTHER
        // pairs would render under this market and arm taker links
        // for the wrong assets). Keep only rows matching the
        // requested market: pair (case-insensitive — indexer rows
        // are lowercase, but don't depend on it) AND tenor. Sale and
        // offset vehicles are excluded client-side too; rows without
        // the fields keep their rows — same behaviour as before the
        // filter. Expired rows are already dropped by the ladder's
        // isLiveMarketRow.
        all.push(
          ...page.offers.filter(
            (o) =>
              o.isSaleVehicle !== true &&
              o.isOffsetVehicle !== true &&
              o.lendingAsset.toLowerCase() === wantLending &&
              o.collateralAsset.toLowerCase() === wantCollateral &&
              o.durationDays === durationDays,
          ),
        );
        if (page.nextBefore === null) return { rows: all, source: 'indexer' };
        before = page.nextBefore;
      }
      return null; // cap hit with a cursor still open — truncated ≠ complete
    },
  });
}

/** How stale the signed book may sit — mirrors the worker's
 *  `Cache-Control: max-age=15` on /signed-offers; refetching harder
 *  would only re-download the same cached body. */
const SIGNED_BOOK_STALE_MS = 15_000;

/** The GASLESS signed-offer book for one (pair, tenor) market (#1131
 *  slice D). Always indexer-sourced — signed orders exist ONLY off-chain
 *  until a taker fills them, so there is no chain leg to prefer; the
 *  ladder's signed-row badge carries that source honesty per row.
 *  Tri-state per the app contract: `undefined` loading, `null`
 *  unavailable (fetch failed / wrong-chain response / no indexer
 *  origin), `[]` honestly empty. The desk merges these ADDITIVELY into
 *  the ladder — an unavailable signed book degrades to a chain-only
 *  ladder rather than blanking the whole market. */
export function useDeskSignedBook(pair: DeskPair | null, durationDays: number) {
  const { readChain } = useActiveChain();
  return useQuery({
    queryKey: [
      'deskSignedBook',
      readChain.chainId,
      pair ? pairKey(pair) : null,
      durationDays,
    ],
    enabled: pair !== null,
    staleTime: SIGNED_BOOK_STALE_MS,
    // RPC read-diet PR A (Codex #1228 r1) — gasless signed POSTS never
    // touch the chain, so no push frame announces new signed depth;
    // polling is its only discovery. Keep today's cadence.
    refetchInterval: idleAware(REFRESH_MS),
    queryFn: async (): Promise<IndexedSignedOffer[] | null> => {
      if (!indexerConfigured()) return null;
      const res = await fetchSignedOffers(readChain.chainId, {
        lendingAsset: pair!.lendingAsset,
        collateralAsset: pair!.collateralAsset,
        durationDays,
      });
      if (res === null) return null;
      // A response for another chain is not this market's book.
      if (res.chainId !== readChain.chainId) return null;
      return Array.isArray(res.offers) ? res.offers : null;
    },
  });
}

/** Executed fills for the (pair, tenor) market, newest first. */
export function useDeskTape(pair: DeskPair | null, durationDays: number) {
  const { readChain } = useActiveChain();
  return useQuery({
    queryKey: [
      'deskTape',
      readChain.chainId,
      pair ? pairKey(pair) : null,
      durationDays,
    ],
    enabled: pair !== null,
    refetchInterval: signalAware(REFRESH_MS),
    queryFn: async (): Promise<IndexedLoan[] | null> => {
      if (!indexerConfigured()) return null;
      // Belt-and-suspenders client-side verification, mirroring the
      // book fallback (Codex #1134 round-5 P2): an older worker
      // ignores the market params AND excludeSaleVehicles=1, so the
      // response may be the GLOBAL cross-status feed — other pairs'
      // fills would print on this market's tape. Keep only rows
      // matching the requested pair (case-insensitive — indexer rows
      // are lowercase, but don't depend on it) + tenor, and drop sale
      // vehicles by the row flag (rows from workers too old to carry
      // `isSaleVehicle` keep their rows — same behaviour as before).
      const wantLending = pair!.lendingAsset.toLowerCase();
      const wantCollateral = pair!.collateralAsset.toLowerCase();
      const matchesMarket = (l: IndexedLoan): boolean =>
        l.isSaleVehicle !== true &&
        l.lendingAsset.toLowerCase() === wantLending &&
        l.collateralAsset.toLowerCase() === wantCollateral &&
        l.durationDays === durationDays;
      // Bounded `nextBefore` walk, same shape as the book fallback
      // (Codex #1134 round-6 P2): against an older worker the first
      // page is the newest 50 GLOBAL loans, so a market whose fills
      // are older than that page would render a false "No fills yet"
      // — a truncated scan presented as a complete empty tape. A row
      // failing the market filter is the tell that the worker ignored
      // the params (a market-scoping worker can only return matching
      // rows); only then does the walk continue, and hitting the page
      // cap with a cursor still open returns null (tri-state
      // "unavailable"), never a possibly-false empty [].
      const fills: IndexedLoan[] = [];
      let before: number | undefined;
      let untrusted = false;
      for (let i = 0; i < TAPE_FALLBACK_PAGES; i++) {
        const page = await fetchRecentLoans(readChain.chainId, {
          limit: 50,
          before,
          lendingAsset: pair!.lendingAsset,
          collateralAsset: pair!.collateralAsset,
          durationDays,
          excludeSaleVehicles: true,
        });
        if (page === null) return null;
        const matched = page.loans.filter(matchesMarket);
        if (matched.length !== page.loans.length) untrusted = true;
        fills.push(...matched);
        // Feed exhausted — the scan is complete either way. A clean
        // first page keeps the pre-walk semantics: whether the worker
        // filtered or the global page happened to be all-this-market,
        // those ARE the newest fills of this market.
        if (page.nextBefore === null || !untrusted) return fills;
        before = page.nextBefore;
      }
      return null; // cap hit on an untrusted feed — truncated ≠ complete
    },
  });
}

/** Executed-rate candle buckets for the (pair, tenor) market (#1130).
 *  Tri-state per the app contract: `undefined` loading, `null`
 *  unavailable (fetch failed / wrong-chain response / no indexer
 *  origin), `[]` honestly empty (a market with zero fills in the
 *  range). 60 s staleTime mirrors the worker's `Cache-Control:
 *  max-age=60` — refetching harder would only re-download the same
 *  cached body. */
export function useDeskCandles(
  pair: DeskPair | null,
  durationDays: number,
  interval: CandleInterval,
  range: CandleRange,
) {
  const { readChain } = useActiveChain();
  return useQuery({
    queryKey: [
      'deskCandles',
      readChain.chainId,
      pair ? pairKey(pair) : null,
      durationDays,
      interval,
      range,
    ],
    enabled: pair !== null,
    staleTime: 60_000,
    refetchInterval: signalAware(60_000),
    queryFn: async (): Promise<RateCandleBucket[] | null> => {
      if (!indexerConfigured()) return null;
      const res = await fetchRateCandles(
        readChain.chainId,
        {
          lendingAsset: pair!.lendingAsset,
          collateralAsset: pair!.collateralAsset,
          durationDays,
        },
        interval,
        range,
      );
      if (res === null) return null;
      // A response for another chain is not this market's history —
      // treat it as unavailable, never render it.
      if (res.chainId !== readChain.chainId) return null;
      return Array.isArray(res.buckets) ? res.buckets : null;
    },
  });
}

/** One page of the History tab's paginated walk — `rows: null` keeps
 *  the tri-state "unavailable" distinguishable inside useInfiniteQuery
 *  (whose queryFn must not return plain null/undefined). */
interface DeskHistoryPage {
  rows: IndexedParticipantLoan[] | null;
  /** Composite (participation-time, loan-id) cursor, opaque here —
   *  passed back verbatim as the next page's `before`. */
  nextBefore: string | null;
}

const HISTORY_PAGE_SIZE = 25;

/** The wallet's PERMANENT desk history (#1130) — every loan it ever
 *  participated in, ALL statuses, newest participation first, via the
 *  indexer's historical-participant route (`/loans/by-participant`). Deliberately
 *  market-AGNOSTIC: it is the wallet's desk history, not the selected
 *  market's. Paginated: `rows` accumulates the loaded pages;
 *  `loadMore()` follows `nextBefore`. `rows === null` = unavailable
 *  (any failed page poisons the answer — a partial list presented as
 *  complete history would be a lie). */
export function useDeskHistory(wallet: string | undefined) {
  const { readChain } = useActiveChain();
  const q = useInfiniteQuery({
    queryKey: ['deskHistory', readChain.chainId, wallet?.toLowerCase()],
    enabled: wallet !== undefined,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: DeskHistoryPage) => last.nextBefore ?? undefined,
    queryFn: async ({ pageParam }): Promise<DeskHistoryPage> => {
      if (!indexerConfigured()) return { rows: null, nextBefore: null };
      const page = await fetchLoansByParticipant(readChain.chainId, wallet!, {
        limit: HISTORY_PAGE_SIZE,
        before: pageParam,
      });
      // Wrong-chain responses are as unusable as failed ones.
      if (page === null || page.chainId !== readChain.chainId) {
        return { rows: null, nextBefore: null };
      }
      return { rows: page.loans, nextBefore: page.nextBefore };
    },
  });

  const rows = useMemo((): IndexedParticipantLoan[] | null | undefined => {
    const pages = q.data?.pages;
    if (pages === undefined) return undefined; // still loading page 1
    const out: IndexedParticipantLoan[] = [];
    for (const p of pages) {
      if (p.rows === null) return null; // any failed page → unavailable
      out.push(...p.rows);
    }
    return out;
  }, [q.data]);

  return {
    rows,
    isLoading: q.isLoading,
    hasMore: q.hasNextPage,
    isLoadingMore: q.isFetchingNextPage,
    loadMore: () => void q.fetchNextPage(),
    retry: () => void q.refetch(),
  };
}

// ---------------------------------------------------------------------------
// Ladder math (pure — unit-testable, no hooks)
// ---------------------------------------------------------------------------

/** Unfilled remainder of an offer — depth aggregates THIS, never the
 *  headline `amountMax` (a half-filled offer is half the liquidity). */
export function offerRemaining(o: IndexedOffer): bigint {
  try {
    return BigInt(o.amountMax || '0') - BigInt(o.amountFilled || '0');
  } catch {
    return 0n;
  }
}

/** A row belongs in the (pair, tenor) ladder only when it is live:
 *  active, ERC-20 on BOTH legs (NFT legs carry token identity and
 *  must not merge into a fungible rate level), the exact tenor (the
 *  matcher requires exact durationDays equality — depth at other
 *  tenors cannot cross), not lazily-expired GTT, and with remaining
 *  size. */
export function isLiveMarketRow(
  o: IndexedOffer,
  durationDays: number,
  nowSec: number,
): boolean {
  return (
    o.status === 'active' &&
    o.assetType === AssetType.ERC20 &&
    o.collateralAssetType === AssetType.ERC20 &&
    o.durationDays === durationDays &&
    !(o.expiresAt !== undefined && o.expiresAt !== 0 && o.expiresAt <= nowSec) &&
    offerRemaining(o) > 0n
  );
}

export interface LadderLevel {
  rateBps: number;
  /** Total remaining principal at this rate (lending-asset base units). */
  size: bigint;
  /** Running depth from the top of this side. Signed off-chain rows
   *  (rows carrying the `signed` tag — see `DeskBookRow`) aggregate
   *  into the same level as on-chain rows at the same rate; consumers
   *  that must not treat a signed row as an on-chain offer
   *  discriminate on the tag. */
  cumulative: bigint;
  offers: DeskBookRow[];
  /** The connected wallet has an order at this level. */
  own: boolean;
}

export interface DeskLadder {
  /** Lender offers keyed on their floor rate, best (lowest) first. */
  asks: LadderLevel[];
  /** Borrower offers keyed on their ceiling rate, best (highest) first. */
  bids: LadderLevel[];
  bestAskBps: number | null;
  bestBidBps: number | null;
  /** Midpoint of best bid/ask when both sides exist. */
  midBps: number | null;
  /** bestAsk − bestBid; negative = crossed (a normal resting state
   *  here, unlike a CEX — range offers may still not overlap). */
  spreadBps: number | null;
}

export function buildLadder(
  rows: DeskBookRow[],
  durationDays: number,
  nowSec: number,
  wallet: string | undefined,
): DeskLadder {
  const live = rows.filter((o) => isLiveMarketRow(o, durationDays, nowSec));
  const me = wallet?.toLowerCase();
  const side = (offerType: 0 | 1): LadderLevel[] => {
    const byRate = new Map<number, LadderLevel>();
    for (const o of live) {
      if (o.offerType !== offerType) continue;
      // Asks = lender floor (`interestRateBps`); bids = borrower
      // ceiling (`interestRateBpsMax`) — the headline each side's
      // direct accept binds.
      const rate = offerType === 0 ? o.interestRateBps : o.interestRateBpsMax;
      let lvl = byRate.get(rate);
      if (!lvl) {
        lvl = { rateBps: rate, size: 0n, cumulative: 0n, offers: [], own: false };
        byRate.set(rate, lvl);
      }
      lvl.size += offerRemaining(o);
      lvl.offers.push(o);
      if (me && o.creator.toLowerCase() === me) lvl.own = true;
    }
    const levels = [...byRate.values()].sort((a, b) =>
      offerType === 0 ? a.rateBps - b.rateBps : b.rateBps - a.rateBps,
    );
    let run = 0n;
    for (const l of levels) {
      run += l.size;
      l.cumulative = run;
    }
    return levels;
  };
  const asks = side(0);
  const bids = side(1);
  const bestAskBps = asks.length > 0 ? asks[0].rateBps : null;
  const bestBidBps = bids.length > 0 ? bids[0].rateBps : null;
  const midBps =
    bestAskBps !== null && bestBidBps !== null
      ? (bestAskBps + bestBidBps) / 2
      : null;
  const spreadBps =
    bestAskBps !== null && bestBidBps !== null ? bestAskBps - bestBidBps : null;
  return { asks, bids, bestAskBps, bestBidBps, midBps, spreadBps };
}

/** The taker affordance arms ONLY on unfilled, unexpired, not-own rows
 *  — direct `acceptOffer` rejects partially-filled offers
 *  (`OfferPartiallyFilled`) and expired ones (`OfferExpired`), so a
 *  button on any other shape would mint a doomed transaction. Expiry
 *  is already excluded by `isLiveMarketRow` upstream. Signed off-chain
 *  rows are SKIPPED: they have no on-chain offer id to deep-link into
 *  the guided accept (their sentinel id would mint /borrow?offer=-1) —
 *  they carry their own inline fill affordance instead (#1131 slice D,
 *  see `signedFillCandidate`). */
export function takerCandidate(
  level: LadderLevel | undefined,
  wallet: string | undefined,
): IndexedOffer | null {
  if (!level) return null;
  const me = wallet?.toLowerCase();
  return (
    level.offers.find(
      (o) =>
        o.signed === undefined &&
        BigInt(o.amountFilled || '0') === 0n &&
        (!me || o.creator.toLowerCase() !== me),
    ) ?? null
  );
}

/** The signed-fill affordance's candidate at a level: the first signed
 *  row that is not the connected wallet's own (a maker can't fill their
 *  own order — `acceptSignedOffer` would have the same party on both
 *  legs), still has remaining size, AND is completely unfilled. The
 *  last condition mirrors the contract (Codex #1145 round-1 P2 #5):
 *  `SignedOfferFacet._vetSignedOffer` reverts `SignedOfferConsumed` on
 *  ANY non-zero `signedOfferFilled[orderHash]`, so a signed order the
 *  matcher partially filled can never be DIRECT-filled — arming Fill on
 *  it would walk the taker into a doomed confirm ("gone" before
 *  signing). The remainder is still honestly on the book: it stays
 *  matchable via `matchSignedOffer` (whose vetting allows
 *  `filled < ceiling`), so the row keeps resting as ladder DEPTH — it
 *  just carries no direct-fill button (the badge tooltip says why).
 *
 *  The candidate must also be SINGLE-VALUE on principal (Codex #1145
 *  round-2 P2): `acceptSignedOffer` marks the fill ledger consumed to
 *  the CEILING (`signedOfferFilled[orderHash] = _ceiling(o)`) but the
 *  materialized accept binds the ROLE amount — for a borrower offer
 *  that is the headline FLOOR (`offer.amount`, OfferAcceptFacet's
 *  `effectivePrincipal`). A ranged borrower order advertising 100 of
 *  depth would direct-fill only its floor and vaporize the rest of the
 *  ledger. Ranged rows keep resting as depth for the matcher path
 *  (`matchSignedOffer` slices decrement the ledger honestly); only
 *  single-value rows (`amount == ceiling`; `amountMax == 0` is the
 *  single-value wire sentinel) arm the direct fill. The desk's own
 *  ticket can no longer produce a ranged signed order (lender payloads
 *  are collapsed by `collapseForSignedPost`, borrower payloads ship
 *  single-value on both legs) — this gate defends against RANGE orders
 *  posted straight to the public indexer API. */
export function signedFillCandidate(
  level: LadderLevel | undefined,
  wallet: string | undefined,
): DeskBookRow | null {
  if (!level) return null;
  const me = wallet?.toLowerCase();
  return (
    level.offers.find(
      (o) =>
        o.signed !== undefined &&
        // `amountFilled` on a signed row is the mapper's mirror of the
        // on-chain fill ledger (`signedRowToDeskRow`) — non-zero means
        // the direct-accept vetting rejects it.
        BigInt(o.amountFilled || '0') === 0n &&
        offerRemaining(o) > 0n &&
        // Ranged rows never direct-fill (floor-bind / ceiling-consume
        // depth vaporization — see the doc comment above).
        signedOrderIsSingleValue(o.signed.order) &&
        (!me || o.signed.signer.toLowerCase() !== me),
    ) ?? null
  );
}

// ---------------------------------------------------------------------------
// Crossable-band previewMatch (#1131 slice B)
// ---------------------------------------------------------------------------

/**
 * The TOP-of-book pair `previewMatch` / `matchOffers` runs on when the
 * book is crossed/crossable (`bestBidBps >= bestAskBps`): the best ask
 * level's first offer id × the best bid level's first offer id. Signed
 * off-chain rows are skipped when picking each side's first offer —
 * `matchOffers` can only cross ON-CHAIN offers (a signed order has no
 * offer id until a taker materializes it), so a purely-signed best
 * level yields no matchable pair even though the QUOTED book crosses.
 * Returns `null` when the book isn't crossed or either side lacks an
 * on-chain offer at its best level.
 */
export function topOfBookMatchPair(
  ladder: DeskLadder | null,
): { lenderOfferId: number; borrowerOfferId: number } | null {
  if (
    ladder === null ||
    ladder.bestAskBps === null ||
    ladder.bestBidBps === null ||
    ladder.bestBidBps < ladder.bestAskBps
  ) {
    return null;
  }
  const lender = ladder.asks[0]?.offers.find((o) => o.signed === undefined);
  const borrower = ladder.bids[0]?.offers.find((o) => o.signed === undefined);
  if (!lender || !borrower) return null;
  return { lenderOfferId: lender.offerId, borrowerOfferId: borrower.offerId };
}

/** `OfferMatchFacet.previewMatch` result, decoded. `errorCode === 0`
 *  (`MatchError.Ok`) is the ONLY state that renders the crossable band
 *  — bid >= ask alone is NOT matchable (range offers' amount/collateral
 *  constraints can still fail), and showing a band the contract would
 *  refuse is exactly the dishonesty the design's §5.2 rule forbids. */
export interface MatchPreview {
  errorCode: number;
  matchAmount: bigint;
  matchRateBps: number;
  reqCollateral: bigint;
  lenderRemainingPostMatch: bigint;
}

/** One LIVE `previewMatch` read — shared by the cached hook below AND
 *  the MatchBand's pre-write recheck (Codex #1145 round-5 P2: the 30s
 *  interval can leave a stale Ok on screen, so the submit handler
 *  re-reads the contract's verdict directly, never through the cache,
 *  immediately before `matchOffers`). `null` = read failed / selector
 *  missing — callers treat it as "not confirmed matchable" (fail
 *  closed; the band is advisory AND previewMatch is the only source of
 *  the rate/amount it displays, so there is nothing to render without
 *  it). */
export async function readMatchPreviewLive(
  publicClient: PublicClient,
  diamondAddress: `0x${string}`,
  pair: { lenderOfferId: number; borrowerOfferId: number },
): Promise<MatchPreview | null> {
  try {
    const r = (await publicClient.readContract({
      address: diamondAddress,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'previewMatch',
      args: [BigInt(pair.lenderOfferId), BigInt(pair.borrowerOfferId)],
    })) as {
      errorCode: number;
      matchAmount: bigint;
      matchRateBps: bigint;
      reqCollateral: bigint;
      lenderRemainingPostMatch: bigint;
    };
    return {
      errorCode: Number(r.errorCode),
      matchAmount: r.matchAmount,
      matchRateBps: Number(r.matchRateBps),
      reqCollateral: r.reqCollateral,
      lenderRemainingPostMatch: r.lenderRemainingPostMatch,
    };
  } catch {
    return null; // older deploy without the selector / RPC failure
  }
}

/** One LIVE `RiskPreviewFacet.previewMatchRiskBlock` read (Codex #1145
 *  round-5 P2: `previewMatch` Ok alone is NOT sufficient on risk-gated
 *  deployments — `OfferMatchFacet._executeMatch` additionally runs
 *  `_assertMatchCreatorsRiskAccess(lenderOfferId, borrowerOfferId)`
 *  (OfferMatchFacet.sol:930), and `previewMatchRiskBlock`
 *  (RiskPreviewFacet.sol:220) is its non-reverting mirror). Returns the
 *  contract's block code (0 = clear; gate disabled also reads 0 — the
 *  retail default), with two deliberate failure postures:
 *   - MISSING SELECTOR → 0 (fail OPEN): a pre-#1104 Diamond without
 *     RiskPreviewFacet may still enforce the gate at write time, but
 *     the band is advisory and hiding it FOREVER on old deployments
 *     would kill the feature — the same posture the direct-accept path
 *     takes for a missing `previewOfferAcceptBlock`
 *     (useAcceptTerms.ts: "older deploy without the preview — proceed,
 *     the contract still enforces").
 *   - TRANSPORT failure → `null` (fail CLOSED): callers hide/refuse
 *     while the answer is unknown, consistent with the band's
 *     masterFlags posture — retrying a read is free, a doomed
 *     `matchOffers` costs the matcher gas. */
export async function readMatchRiskBlockLive(
  publicClient: PublicClient,
  diamondAddress: `0x${string}`,
  pair: { lenderOfferId: number; borrowerOfferId: number },
): Promise<number | null> {
  try {
    const code = (await publicClient.readContract({
      address: diamondAddress,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'previewMatchRiskBlock',
      args: [BigInt(pair.lenderOfferId), BigInt(pair.borrowerOfferId)],
    })) as number | bigint;
    return Number(code);
  } catch (e) {
    if (isMissingSelectorError(e)) return 0; // fail open — see above
    return null; // transport failure — fail closed
  }
}

/** Live `previewMatch` read for the top-of-book pair. Keyed on the two
 *  offer ids so a book change (new top of book) re-runs it; the poll
 *  interval additionally re-checks the SAME pair (a partial fill can
 *  flip a previously-Ok preview without changing the ids), and the
 *  root also sits in LiveChainSync's LIVE_KEYS so WS deploys refresh
 *  it per block. `null` = read failed — the band hides (advisory
 *  surface fails closed). */
export function usePreviewMatch(
  pair: { lenderOfferId: number; borrowerOfferId: number } | null,
) {
  const { readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  return useQuery({
    queryKey: [
      'deskPreviewMatch',
      readChain.chainId,
      pair?.lenderOfferId ?? null,
      pair?.borrowerOfferId ?? null,
    ],
    enabled: pair !== null && Boolean(publicClient),
    // RPC read-diet PR A (Codex #1228 r1) — crossability is an ACTION
    // gate: stretch only when the chain WS tip nudge actually covers it
    // (LiveChainSync never mounts on HTTP-only chains).
    refetchInterval: tipAware(REFRESH_MS, Boolean(readChain.wsUrl)),
    queryFn: () =>
      readMatchPreviewLive(publicClient!, readChain.diamondAddress, pair!),
  });
}

/** Cached `previewMatchRiskBlock` for the top-of-book pair — the
 *  render-time half of the risk gate (see readMatchRiskBlockLive for
 *  the codes + failure postures). Shares the 'deskPreviewMatch' root
 *  (with a discriminator segment) so every existing invalidation of
 *  the preview — MatchBand's post-write sweep and LiveChainSync's
 *  per-block pass — covers both reads without a second registration. */
export function usePreviewMatchRiskBlock(
  pair: { lenderOfferId: number; borrowerOfferId: number } | null,
) {
  const { readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  return useQuery({
    queryKey: [
      'deskPreviewMatch',
      readChain.chainId,
      pair?.lenderOfferId ?? null,
      pair?.borrowerOfferId ?? null,
      'riskBlock',
    ],
    enabled: pair !== null && Boolean(publicClient),
    // RPC read-diet PR A (Codex #1228 r1) — crossability is an ACTION
    // gate: stretch only when the chain WS tip nudge actually covers it
    // (LiveChainSync never mounts on HTTP-only chains).
    refetchInterval: tipAware(REFRESH_MS, Boolean(readChain.wsUrl)),
    queryFn: () =>
      readMatchRiskBlockLive(publicClient!, readChain.diamondAddress, pair!),
  });
}

// ---------------------------------------------------------------------------
// Symbols + amend-source reads
// ---------------------------------------------------------------------------

/** Resolve ERC-20 symbols for a set of addresses (market chips need
 *  many at once — one cached batch beats a hook per address). Missing
 *  entries stay unresolved; callers fall back to a short address. */
export function useSymbolMap(addresses: string[]): Record<string, string> {
  const { readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  const key = useMemo(
    () => [...new Set(addresses.map((a) => a.toLowerCase()))].sort(),
    [addresses],
  );
  const q = useQuery({
    queryKey: ['deskSymbols', readChain.chainId, key],
    enabled: key.length > 0 && Boolean(publicClient),
    staleTime: Infinity,
    queryFn: async (): Promise<Record<string, string>> => {
      const out: Record<string, string> = {};
      await Promise.all(
        key.map(async (addr) => {
          try {
            out[addr] = await publicClient!.readContract({
              address: addr as `0x${string}`,
              abi: erc20Abi,
              functionName: 'symbol',
            });
          } catch {
            // not an ERC-20 / read failed — caller falls back
          }
        }),
      );
      return out;
    },
  });
  return q.data ?? {};
}

/** The LIVE mutable values of one offer — the amend form must start
 *  from the chain's current numbers (the indexer row omits
 *  `collateralAmountMax`, and `modifyOffer` treats "supplied ==
 *  existing" as "leave this cluster alone", so stale pre-fills would
 *  silently mutate the wrong cluster). */
export interface AmendSource {
  offerType: number;
  /** LibVaipakam.FillMode (0 Partial / 1 Aon / 2 Ioc) — AON offers
   *  must keep `amount == amountMax` through a modify (the invariant
   *  is enforced at create and NOT re-checked by the facet, so a
   *  diverging amend would silently break all-or-none semantics). */
  fillMode: number;
  lendingAsset: string;
  collateralAsset: string;
  amount: bigint;
  amountMax: bigint;
  amountFilled: bigint;
  interestRateBps: number;
  interestRateBpsMax: number;
  collateralAmount: bigint;
  collateralAmountMax: bigint;
  /** Borrower collateral already committed to live partial fills —
   *  `collateralAmountMax` cannot drop below it (ModifyBelowFilledFloor). */
  collateralAmountFilled: bigint;
}

export function useAmendSource(offerId: number | undefined) {
  const { readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  return useQuery({
    queryKey: ['deskAmendSource', readChain.chainId, offerId],
    enabled: offerId !== undefined && Boolean(publicClient),
    staleTime: 0,
    queryFn: async (): Promise<AmendSource> => {
      const o = (await publicClient!.readContract({
        address: readChain.diamondAddress,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'getOffer',
        args: [BigInt(offerId!)],
      })) as Record<string, unknown>;
      return {
        offerType: Number(o.offerType),
        fillMode: Number(o.fillMode),
        lendingAsset: String(o.lendingAsset),
        collateralAsset: String(o.collateralAsset),
        amount: BigInt(o.amount as bigint),
        amountMax: BigInt(o.amountMax as bigint),
        amountFilled: BigInt(o.amountFilled as bigint),
        interestRateBps: Number(o.interestRateBps),
        interestRateBpsMax: Number(o.interestRateBpsMax),
        collateralAmount: BigInt(o.collateralAmount as bigint),
        collateralAmountMax: BigInt(o.collateralAmountMax as bigint),
        collateralAmountFilled: BigInt(o.collateralAmountFilled as bigint),
      };
    },
  });
}
