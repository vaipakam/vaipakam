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
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { erc20Abi, type PublicClient } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { useActiveChain } from '../chain/useActiveChain';
import { idleAware } from '../lib/idle';
import { AssetType } from '../lib/types';
import {
  fetchActiveOffers,
  fetchOffersMarkets,
  fetchRecentLoans,
  indexerConfigured,
  type IndexedLoan,
  type IndexedOffer,
  type MarketSummary,
} from './indexer';
import { readOfferRowsBatchLive } from './chainPositions';

const REFRESH_MS = 30_000;
/** Indexer-fallback page walk bound — same shape as useActiveOffers'
 *  cap: hitting it with a cursor still open returns null (truncated
 *  ≠ complete), never a confident half-book. */
const BOOK_FALLBACK_PAGES = 5;

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
    refetchInterval: idleAware(REFRESH_MS),
    queryFn: async (): Promise<MarketSummary[] | null> => {
      if (!indexerConfigured()) return null;
      const res = await fetchOffersMarkets(readChain.chainId);
      return res === null ? null : res.markets;
    },
  });
}

/** Offer ids among `rows` that are lender-sale vehicles: borrower-
 *  style offers linked to an existing loan (`getOfferLinkedLoanId !=
 *  0`). Only borrower offers can be sale vehicles, so only those rows
 *  are read; the same-tick reads fold into ONE JSON-RPC batch (the
 *  transports use `batch: true`). Shared by the desk book and the
 *  Open orders panel so the two surfaces can't drift on the rule. */
export async function readSaleVehicleOfferIds(
  publicClient: PublicClient,
  diamondAddress: `0x${string}`,
  rows: readonly IndexedOffer[],
): Promise<Set<number>> {
  const borrowerRows = rows.filter((r) => r.offerType === 1);
  const linkedLoanIds = await Promise.all(
    borrowerRows.map(
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
    borrowerRows.filter((_, i) => linkedLoanIds[i] !== 0n).map((r) => r.offerId),
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
          // Lender-sale vehicles (borrower-style offers linked to an
          // existing loan) are bookkeeping, not quotable liquidity —
          // rendering one as a bid would arm a taker affordance on a
          // non-market row. One extra JSON-RPC batch per book load
          // (see readSaleVehicleOfferIds). The indexer fallback below
          // filters on the worker's `isSaleVehicle` instead.
          const saleVehicleIds = await readSaleVehicleOfferIds(
            publicClient,
            readChain.diamondAddress,
            active,
          );
          return {
            rows: active.filter((r) => !saleVehicleIds.has(r.offerId)),
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
      let before: number | undefined;
      for (let i = 0; i < BOOK_FALLBACK_PAGES; i++) {
        const page = await fetchActiveOffers(readChain.chainId, {
          limit: 100,
          before,
          lendingAsset: pair!.lendingAsset,
          collateralAsset: pair!.collateralAsset,
          durationDays,
        });
        if (page === null) return null;
        // Sale vehicles are excluded here too (the worker marks them
        // via `isSaleVehicle`); an older worker without the field
        // keeps its rows — same behaviour as before the filter.
        all.push(...page.offers.filter((o) => o.isSaleVehicle !== true));
        if (page.nextBefore === null) return { rows: all, source: 'indexer' };
        before = page.nextBefore;
      }
      return null; // cap hit with a cursor still open — truncated ≠ complete
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
    refetchInterval: idleAware(REFRESH_MS),
    queryFn: async (): Promise<IndexedLoan[] | null> => {
      if (!indexerConfigured()) return null;
      const page = await fetchRecentLoans(readChain.chainId, {
        limit: 50,
        lendingAsset: pair!.lendingAsset,
        collateralAsset: pair!.collateralAsset,
        durationDays,
        excludeSaleVehicles: true,
      });
      return page === null ? null : page.loans;
    },
  });
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
  /** Running depth from the top of this side. */
  cumulative: bigint;
  offers: IndexedOffer[];
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
  rows: IndexedOffer[],
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
 *  is already excluded by `isLiveMarketRow` upstream. */
export function takerCandidate(
  level: LadderLevel | undefined,
  wallet: string | undefined,
): IndexedOffer | null {
  if (!level) return null;
  const me = wallet?.toLowerCase();
  return (
    level.offers.find(
      (o) =>
        BigInt(o.amountFilled || '0') === 0n &&
        (!me || o.creator.toLowerCase() !== me),
    ) ?? null
  );
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
  lendingAsset: string;
  collateralAsset: string;
  amount: bigint;
  amountMax: bigint;
  amountFilled: bigint;
  interestRateBps: number;
  interestRateBpsMax: number;
  collateralAmount: bigint;
  collateralAmountMax: bigint;
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
        lendingAsset: String(o.lendingAsset),
        collateralAsset: String(o.collateralAsset),
        amount: BigInt(o.amount as bigint),
        amountMax: BigInt(o.amountMax as bigint),
        amountFilled: BigInt(o.amountFilled as bigint),
        interestRateBps: Number(o.interestRateBps),
        interestRateBpsMax: Number(o.interestRateBpsMax),
        collateralAmount: BigInt(o.collateralAmount as bigint),
        collateralAmountMax: BigInt(o.collateralAmountMax as bigint),
      };
    },
  });
}
