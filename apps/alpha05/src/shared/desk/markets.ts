/**
 * OFF-73 — the Desk's markets and a market's rate ladder, from the index
 * (the world rail, RB-RAILS).
 *
 * A market is one lending token against one collateral token for one term,
 * both legs fungible, as the index groups the open book (`/offers/markets`).
 * The index caps that list at its deepest markets and says when it did; its
 * counts include gasless signed orders, which the desk lists apart from the
 * ladder (OFF-60), so the page says that once, above every view.
 *
 * A market's ladder is the index's market-scoped page of open offers
 * (`/offers/active`), read a bounded number of pages deep, with expired
 * offers and the loan-sale and offset vehicles (bookkeeping, not quotes)
 * left out by the index. Lenders' offers are asks at their floor rate;
 * borrowers' requests are bids at their ceiling rate, the rate each side
 * binds when the other takes it. Each step states how many offers stand at
 * that rate and their open amounts summed: every offer is still taken on
 * its own, so a step's total is depth, never one amount anyone can take in
 * one go. The middle rate is derived from the best ask and the best bid and
 * labelled so; nothing here is a price the protocol reports.
 */
import { getAddress } from 'viem';
import { ASSET_ERC20, OFFER_TYPE_LENDER, type LiveLoanRow } from '../positions/model';
import type { IndexerClient } from '../reads/world/indexerClient';
import { bookRowFrom, lapsed, type BookRow } from '../offers/book';

type Hex = `0x${string}`;
type Json = Record<string, unknown>;

const HEX = /^0x[0-9a-fA-F]{40}$/;

export interface Market {
  lending: Hex;
  collateral: Hex;
  durationDays: number;
  lenderOffers: number;
  borrowerOffers: number;
  /** The lowest lender rate and the highest borrower ceiling the index
   *  holds for the market, signed orders included; null when that side is
   *  empty. */
  bestAskBps: bigint | null;
  bestBidBps: bigint | null;
}

export interface MarketList {
  markets: Market[];
  /** Rows the index returned that this app could not read. */
  unread: number;
  /** The index listed only its deepest markets. */
  truncated: boolean;
}

function count(v: unknown): number {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return v;
  throw new Error('not a count');
}

function rate(v: unknown): bigint | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  throw new Error('not a rate');
}

function addr(v: unknown): Hex {
  if (typeof v === 'string' && HEX.test(v)) return getAddress(v);
  throw new Error('not an address');
}

export function marketFrom(o: Json): Market {
  const durationDays = count(o.durationDays);
  if (durationDays === 0) throw new Error('no term');
  return {
    lending: addr(o.lendingAsset),
    collateral: addr(o.collateralAsset),
    durationDays,
    lenderOffers: count(o.lenderOffers),
    borrowerOffers: count(o.borrowerOffers),
    bestAskBps: rate(o.bestAskBps),
    bestBidBps: rate(o.bestBidBps),
  };
}

/** The markets the index holds for the network, deepest first. Throws (the
 *  indexer's own failure) when the index does not answer. */
export async function readMarkets(indexer: IndexerClient, chainId: number): Promise<MarketList> {
  const res = await indexer.getJson<{ markets?: unknown; truncated?: unknown }>(`/offers/markets?chainId=${chainId}`);
  if (!Array.isArray(res.markets)) throw new Error('The index answered without a market list.');
  const markets: Market[] = [];
  let unread = 0;
  for (const m of res.markets) {
    try {
      markets.push(marketFrom(m as Json));
    } catch {
      unread += 1;
    }
  }
  return { markets, unread, truncated: res.truncated === true };
}

/** A market's place in the page address: `lending-collateral-days`. */
export function marketKey(m: Pick<Market, 'lending' | 'collateral' | 'durationDays'>): string {
  return `${m.lending.toLowerCase()}-${m.collateral.toLowerCase()}-${m.durationDays}`;
}

export function parseMarketKey(key: string | null): Pick<Market, 'lending' | 'collateral' | 'durationDays'> | null {
  const m = key?.match(/^(0x[0-9a-fA-F]{40})-(0x[0-9a-fA-F]{40})-(\d{1,5})$/);
  if (!m) return null;
  const durationDays = Number(m[3]);
  if (durationDays === 0) return null;
  return { lending: getAddress(m[1]!), collateral: getAddress(m[2]!), durationDays };
}

/** How many offers one read of a market covers, and how many reads the
 *  ladder makes before it says it stopped. */
export const LADDER_PAGE = 50;
export const LADDER_PAGES = 4;

export interface MarketBook {
  rows: BookRow[];
  unread: number;
  /** The index had more open offers in the market than the ladder read. */
  more: boolean;
}

/** The market's open offers from the index, up to `LADDER_PAGES` pages. */
export async function readMarketBook(indexer: IndexerClient, chainId: number, m: Pick<Market, 'lending' | 'collateral' | 'durationDays'>): Promise<MarketBook> {
  const rows: BookRow[] = [];
  let unread = 0;
  let before: string | null = null;
  for (let page = 0; page < LADDER_PAGES; page++) {
    const q = new URLSearchParams({
      chainId: String(chainId),
      limit: String(LADDER_PAGE),
      lendingAsset: m.lending.toLowerCase(),
      collateralAsset: m.collateral.toLowerCase(),
      durationDays: String(m.durationDays),
      excludeExpired: '1',
      excludeSaleVehicles: '1',
      excludeOffsetVehicles: '1',
    });
    if (before !== null) q.set('before', before);
    const res = await indexer.getJson<{ offers?: unknown; nextBefore?: unknown }>(`/offers/active?${q.toString()}`);
    if (!Array.isArray(res.offers)) throw new Error('The index answered without an offer list.');
    for (const o of res.offers) {
      try {
        rows.push(bookRowFrom(o as Json));
      } catch {
        unread += 1;
      }
    }
    const next = res.nextBefore;
    before = typeof next === 'number' || typeof next === 'string' ? String(next) : null;
    if (before === null) return { rows, unread, more: false };
  }
  return { rows, unread, more: true };
}

/** One rate on one side of the ladder. */
export interface DeskStep {
  rateBps: bigint;
  offers: BookRow[];
  /** The open amounts of the step's offers, summed: depth, not one take. */
  open: bigint;
}

/** Why an offer the index returned is not on the ladder. */
export interface LadderLeftOut {
  /** Its expiry passed (the index can still file it as open). */
  expired: number;
  /** A leg that is not an ERC-20, or another market's terms. */
  notThisMarket: number;
  /** Bound to a loan position that moved since it opened: it can never
   *  complete (#3205). */
  moved: number;
  /** A loan-sale or offset vehicle the index still returned. */
  vehicle: number;
  /** Nothing of it is left open. */
  filled: number;
}

export interface DeskLadder {
  /** Lenders' offers, lowest rate first. */
  asks: DeskStep[];
  /** Borrowers' requests, highest rate first. */
  bids: DeskStep[];
  bestAskBps: bigint | null;
  bestBidBps: bigint | null;
  /** The middle of the best ask and the best bid, in tenths of a basis
   *  point (exact); null unless both sides have an offer. */
  middleTenthBps: bigint | null;
  /** The best bid is at or above the best ask. */
  crossed: boolean;
  leftOut: LadderLeftOut;
}

/** The rate a side quotes: a lender's floor, a borrower's ceiling. */
export function quoteRate(r: Pick<BookRow, 'offerType' | 'interestRateBps' | 'interestRateBpsMax'>): bigint {
  if (r.offerType === OFFER_TYPE_LENDER) return r.interestRateBps;
  return r.interestRateBpsMax > r.interestRateBps ? r.interestRateBpsMax : r.interestRateBps;
}

/** What is still open of an offer: its upper amount less what was filled. */
export function openAmount(r: Pick<BookRow, 'amount' | 'amountMax' | 'amountFilled'>): bigint {
  const top = r.amountMax > r.amount ? r.amountMax : r.amount;
  return top > r.amountFilled ? top - r.amountFilled : 0n;
}

function steps(rows: readonly BookRow[], highFirst: boolean): DeskStep[] {
  const by = new Map<bigint, DeskStep>();
  for (const r of rows) {
    const rateBps = quoteRate(r);
    const step = by.get(rateBps);
    if (step) {
      step.offers.push(r);
      step.open += openAmount(r);
    } else by.set(rateBps, { rateBps, offers: [r], open: openAmount(r) });
  }
  const out = [...by.values()].sort((a, b) => (a.rateBps < b.rateBps ? -1 : a.rateBps > b.rateBps ? 1 : 0));
  for (const s of out) s.offers.sort((a, b) => (a.id < b.id ? -1 : 1));
  return highFirst ? out.reverse() : out;
}

export function deskLadder(rows: readonly BookRow[], m: Pick<Market, 'lending' | 'collateral' | 'durationDays'>, nowSec: number): DeskLadder {
  const leftOut: LadderLeftOut = { expired: 0, notThisMarket: 0, moved: 0, vehicle: 0, filled: 0 };
  const asks: BookRow[] = [];
  const bids: BookRow[] = [];
  for (const r of rows) {
    if (
      r.assetType !== ASSET_ERC20 ||
      r.collateralAssetType !== ASSET_ERC20 ||
      r.lendingAsset.toLowerCase() !== m.lending.toLowerCase() ||
      r.collateralAsset.toLowerCase() !== m.collateral.toLowerCase() ||
      r.durationDays !== BigInt(m.durationDays)
    ) {
      leftOut.notThisMarket += 1;
    } else if (r.kind === 'loan-sale' || r.kind === 'offset') leftOut.vehicle += 1;
    else if (lapsed(r, nowSec)) leftOut.expired += 1;
    else if (r.moved === true) leftOut.moved += 1;
    else if (openAmount(r) === 0n) leftOut.filled += 1;
    else (r.offerType === OFFER_TYPE_LENDER ? asks : bids).push(r);
  }
  const a = steps(asks, false);
  const b = steps(bids, true);
  const bestAskBps = a[0]?.rateBps ?? null;
  const bestBidBps = b[0]?.rateBps ?? null;
  const both = bestAskBps !== null && bestBidBps !== null;
  return {
    asks: a,
    bids: b,
    bestAskBps,
    bestBidBps,
    middleTenthBps: both ? (bestAskBps + bestBidBps) * 5n : null,
    crossed: both && bestBidBps >= bestAskBps,
    leftOut,
  };
}

/** One of the viewer's own offers on a ladder, with how much of it was
 *  taken as the index last recorded it (OFF-75). */
export interface OwnOrder {
  id: bigint;
  lender: boolean;
  rateBps: bigint;
  /** The most the offer can lend or borrow. */
  total: bigint;
  taken: bigint;
  open: bigint;
}

/** The viewer's offers on the ladder, lenders' first, each side by rate as
 *  the ladder orders it. Offers the ladder leaves out are not orders anyone
 *  can take, so they are not listed here; the ladder counts them. */
export function ownOrders(l: Pick<DeskLadder, 'asks' | 'bids'>, viewer: string): OwnOrder[] {
  const me = viewer.toLowerCase();
  const out: OwnOrder[] = [];
  for (const s of [...l.asks, ...l.bids]) {
    for (const r of s.offers) {
      if (r.creator.toLowerCase() !== me) continue;
      const total = r.amountMax > r.amount ? r.amountMax : r.amount;
      out.push({ id: r.id, lender: r.offerType === OFFER_TYPE_LENDER, rateBps: s.rateBps, total, taken: r.amountFilled, open: openAmount(r) });
    }
  }
  return out;
}

/** The viewer's live loans in one market: both legs tokens, the market's
 *  two tokens and its term. The rows come from the viewer's own chain read
 *  of its positions, never from the index. */
export function loansInMarket(rows: readonly LiveLoanRow[], m: Pick<Market, 'lending' | 'collateral' | 'durationDays'>): LiveLoanRow[] {
  return rows.filter(
    (r) =>
      r.loan.assetType === ASSET_ERC20 &&
      r.loan.collateralAssetType === ASSET_ERC20 &&
      r.loan.principalAsset.toLowerCase() === m.lending.toLowerCase() &&
      r.loan.collateralAsset.toLowerCase() === m.collateral.toLowerCase() &&
      r.loan.durationDays === BigInt(m.durationDays),
  );
}
