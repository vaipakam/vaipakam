/**
 * OFF-60 (slice 1) — the signed orders the offer book lists on one desk
 * market, every maker's, and where the chain stands on each.
 *
 * The list comes from the offer book (the world rail, RB-RAILS): its
 * market-scoped read, each side capped at its best-priced rows. The book
 * serves only orders it holds as active and unexpired, and it can lag the
 * chain both ways, so each order's standing is read from the chain itself
 * (the same rule as the maker's own list, `mySignedOrders`): used,
 * nonce-cancelled or lapsed orders are shown so, never as open, and a part
 * filled order shows what is left under its ceiling.
 *
 * A signed order sets nothing aside: a fill draws the maker's stake from
 * the maker's own vault at that moment. So each fillable order also states
 * what the maker's vault holds free of that stake now, by the protocol's
 * own count (`freeHolding`), against what a fill of the rest would draw.
 * One maker's orders share that free balance; each is weighed against it
 * alone, and the page says so.
 *
 * Each row is read as the book's own wire form and kept only when its hash
 * is the order's own and it names this market; anything else is counted as
 * unreadable and said, never dropped silently.
 */
import type { Abi, PublicClient } from 'viem';
import { VaultDepositoryFacetABI } from '@vaipakam/contracts/abis';
import { ASSET_TYPE } from '../nft/nft';
import { answerOrNull } from '../reads/answer';
import type { IndexerClient } from '../reads/world/indexerClient';
import {
  fillable,
  readSignedStandings,
  replayCountFrom,
  signedOrderRowFrom,
  type MySignedOrder,
  type SignedMarket,
  type SignedStanding,
} from './mySignedOrders';
import { SIGNED_LENDER, signedStakeLeft, type SignedOrderWire } from './signedOrder';

type Hex = `0x${string}`;

const DEPOSITORY = VaultDepositoryFacetABI as Abi;

/** An ECDSA signature as the book stores it (it takes no contract signers). */
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;

/** One order on the market's signed book, with the signature a fill sends. */
export interface BookSignedOrder extends MySignedOrder {
  signature: Hex;
}

export interface MarketSignedBook {
  /** Lenders' signed orders, lowest rate first. */
  asks: BookSignedOrder[];
  /** Borrowers' signed orders, highest rate first. */
  bids: BookSignedOrder[];
  /** Rows the book returned that this app could not read as an order on
   *  this market. */
  unread: number;
  /** The book returned only its best-priced rows on at least one side. */
  truncated: boolean;
  /** Orders on this market the book holds back while it re-checks them
   *  against the chain after a replacement of recent blocks; null when its
   *  answer on that could not be read. */
  awaitingReplay: number | null;
}

/** One book row as a signed order on `market`, any maker's, or null. */
export function bookSignedOrderFrom(row: unknown, market: SignedMarket): BookSignedOrder | null {
  const read = signedOrderRowFrom(row, market, null);
  if (read === null) return null;
  const signature = (row as Record<string, unknown>).signature;
  if (typeof signature !== 'string' || !SIGNATURE.test(signature)) return null;
  return { ...read, signature: signature.toLowerCase() as Hex };
}

/** The rate an order stands at on its side: a lender's floor rate, a
 *  borrower's ceiling (the higher of its rate and its rate maximum), the
 *  same rule as the ladder of posted offers. */
export function standingRateBps(o: SignedOrderWire): bigint {
  const rate = BigInt(o.interestRateBps);
  if (o.offerType === SIGNED_LENDER) return rate;
  const max = BigInt(o.interestRateBpsMax);
  return max > rate ? max : rate;
}

/** Each side in price order: the best rate for a taker first, the book's
 *  own order kept between equal rates. */
export function sortSides(orders: readonly BookSignedOrder[]): Pick<MarketSignedBook, 'asks' | 'bids'> {
  const asks: BookSignedOrder[] = [];
  const bids: BookSignedOrder[] = [];
  for (const o of orders) (o.order.offerType === SIGNED_LENDER ? asks : bids).push(o);
  const by = (dir: 1 | -1) => (a: BookSignedOrder, b: BookSignedOrder) => {
    const ra = standingRateBps(a.order);
    const rb = standingRateBps(b.order);
    return ra === rb ? 0 : (ra < rb ? -1 : 1) * dir;
  };
  return { asks: asks.sort(by(1)), bids: bids.sort(by(-1)) };
}

/** The market's signed book as the offer book lists it. */
export async function readMarketSignedBook(indexer: IndexerClient, chainId: number, market: SignedMarket): Promise<MarketSignedBook> {
  const q = new URLSearchParams({
    chainId: String(chainId),
    lendingAsset: market.lending.toLowerCase(),
    collateralAsset: market.collateral.toLowerCase(),
    durationDays: String(market.durationDays),
  });
  const res = await indexer.getJson<{ offers?: unknown; truncated?: unknown; awaitingReplay?: unknown }>(`/signed-offers?${q.toString()}`);
  if (!Array.isArray(res.offers)) throw new Error('The offer book answered without an order list.');
  const orders: BookSignedOrder[] = [];
  let unread = 0;
  for (const row of res.offers) {
    const o = bookSignedOrderFrom(row, market);
    if (o === null) unread += 1;
    else if (!orders.some((x) => x.orderHash === o.orderHash)) orders.push(o);
  }
  return { ...sortSides(orders), unread, truncated: res.truncated === true, awaitingReplay: replayCountFrom(res.awaitingReplay) };
}

/** Where the chain stands on each order, and what each maker's vault holds
 *  free of each stake asset, all read at one block. */
export interface SignedBookChain {
  chainNow: number;
  standings: Map<Hex, SignedStanding>;
  filled: Map<Hex, bigint>;
  /** Keyed by `freeKey(signer, asset)`; null when that read failed. */
  free: Map<string, bigint | null>;
}

export function freeKey(signer: string, asset: string): string {
  return `${signer.toLowerCase()}:${asset.toLowerCase()}`;
}

export async function readSignedBookChain(c: PublicClient, diamond: Hex, orders: readonly BookSignedOrder[]): Promise<SignedBookChain> {
  const block = await c.getBlock({ blockTag: 'latest' });
  const { chainNow, standings, filled } = await readSignedStandings(c, diamond, orders, block);
  const pairs = new Map<string, { signer: Hex; asset: Hex }>();
  for (const o of orders) {
    const asset = signedStakeLeft(o.order, 0n).asset;
    pairs.set(freeKey(o.order.signer, asset), { signer: o.order.signer as Hex, asset });
  }
  const free = new Map<string, bigint | null>();
  await Promise.all(
    [...pairs].map(async ([key, p]) => {
      const amount = await answerOrNull(
        c.readContract({
          address: diamond,
          abi: DEPOSITORY,
          functionName: 'freeHolding',
          args: [p.signer, ASSET_TYPE.erc20, p.asset, 0n],
          blockNumber: block.number,
        }) as Promise<bigint>,
      );
      free.set(key, amount);
    }),
  );
  return { chainNow, standings, filled, free };
}

/** Whether the maker's vault holds free what a fill of the rest would draw. */
export type MakerCover =
  | { kind: 'covers'; need: bigint; free: bigint }
  | { kind: 'short'; need: bigint; free: bigint }
  /** The vault's free balance could not be read. */
  | { kind: 'unread' }
  /** Nothing is left to fill, so there is nothing to weigh. */
  | { kind: 'none' };

export function makerCover(o: SignedOrderWire, standing: SignedStanding, filled: bigint | undefined, free: bigint | null | undefined): MakerCover {
  if (!fillable(standing)) return { kind: 'none' };
  const need = signedStakeLeft(o, filled ?? 0n).amount;
  if (need === 0n) return { kind: 'none' };
  if (free === null || free === undefined) return { kind: 'unread' };
  return free >= need ? { kind: 'covers', need, free } : { kind: 'short', need, free };
}
