/**
 * OFF-61 — the viewer's own signed orders on one desk market, and where the
 * chain stands on each.
 *
 * The list comes from the offer book (the world rail, RB-RAILS), scoped to
 * the viewer as signer, so other makers' depth can never push a maker's own
 * orders out of it (`GET /signed-offers?…&signer=`). The book serves only
 * orders it holds as active and unexpired; it can lag the chain both ways,
 * so every row's standing is then read from the chain itself before any
 * cancel is offered: an order the chain already holds as used (filled or
 * cancelled: the protocol keeps one mark for both) or whose nonce was
 * cancelled is shown so, never as open.
 *
 * Each row is read as the book's own wire form, and kept only when its hash
 * is the order's own and it names this viewer and this market; anything
 * else is counted as unreadable and said, never dropped silently.
 *
 * After the chain replaces recent blocks, the book re-reads the fills and
 * cancels of the orders it holds (#3411). While it does, it leaves those
 * orders out of the shared book and counts them (`awaitingReplay`); a
 * signer-scoped read still lists them, flagged `replayPending`, so the maker
 * keeps the way to cancel. The flag is carried to the row so the page can
 * say the order is held back; its standing still comes from the chain.
 */
import type { Abi, PublicClient } from 'viem';
import { SignedOfferFacetABI } from '@vaipakam/contracts/abis';
import { parseStoredOrderJson } from '@vaipakam/lib/signedOfferWire';
import { answerOrNull } from '../reads/answer';
import type { IndexerClient } from '../reads/world/indexerClient';
import { lapsesAt, orderHashOf, signedCeiling, type SignedOrderWire } from './signedOrder';

type Hex = `0x${string}`;

export const SIGNED_OFFER = SignedOfferFacetABI as Abi;

const HASH = /^0x[0-9a-f]{64}$/;

export interface SignedMarket {
  lending: Hex;
  collateral: Hex;
  durationDays: number;
}

export interface MySignedOrder {
  orderHash: Hex;
  order: SignedOrderWire;
  /** The book is re-checking this order against the chain after a
   *  replacement of recent blocks, and leaves it out of the shared book
   *  until it has (a signer-scoped read only). */
  replayPending: boolean;
}

export interface MySignedOrders {
  orders: MySignedOrder[];
  /** Rows the book returned that this app could not read as the viewer's
   *  own order on this market. */
  unread: number;
  /** The book returned only part of the viewer's orders. */
  truncated: boolean;
}

/**
 * The book's count of a market's orders held back for a re-check against
 * the chain: 0 when the book does not send it, null when it sends a value
 * this app cannot read, so a malformed answer is said rather than read as
 * none held back.
 */
export function replayCountFrom(v: unknown): number | null {
  if (v === undefined) return 0;
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/** One book row as an order of `signer`'s on `market`, or null. */
export function mySignedOrderFrom(row: unknown, signer: Hex, market: SignedMarket): MySignedOrder | null {
  return signedOrderRowFrom(row, market, signer);
}

/** One book row as an order on `market`, or null: of `signer`'s only, or
 *  of any maker's when `signer` is null. */
export function signedOrderRowFrom(row: unknown, market: SignedMarket, signer: Hex | null): MySignedOrder | null {
  if (row === null || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  if (typeof r.orderHash !== 'string' || !HASH.test(r.orderHash)) return null;
  // The book stores the canonical text and serves it parsed; serialized
  // again it must be that same text, every field in its wire form.
  const parsed = parseStoredOrderJson(JSON.stringify(r.order ?? null));
  if ('error' in parsed) return null;
  const order = parsed.order;
  if (orderHashOf(order) !== r.orderHash) return null;
  if (signer !== null && order.signer !== signer.toLowerCase()) return null;
  if (order.lendingAsset !== market.lending.toLowerCase() || order.collateralAsset !== market.collateral.toLowerCase()) return null;
  if (order.durationDays !== String(market.durationDays)) return null;
  return { orderHash: r.orderHash as Hex, order, replayPending: r.replayPending === true };
}

/** The viewer's signed orders the book lists on one market. */
export async function readMySignedOrders(indexer: IndexerClient, chainId: number, market: SignedMarket, signer: Hex): Promise<MySignedOrders> {
  const q = new URLSearchParams({
    chainId: String(chainId),
    lendingAsset: market.lending.toLowerCase(),
    collateralAsset: market.collateral.toLowerCase(),
    durationDays: String(market.durationDays),
    signer: signer.toLowerCase(),
  });
  const res = await indexer.getJson<{ offers?: unknown; truncated?: unknown }>(`/signed-offers?${q.toString()}`);
  if (!Array.isArray(res.offers)) throw new Error('The offer book answered without an order list.');
  const orders: MySignedOrder[] = [];
  let unread = 0;
  for (const row of res.offers) {
    const mine = mySignedOrderFrom(row, signer, market);
    if (mine === null) unread += 1;
    else if (!orders.some((o) => o.orderHash === mine.orderHash)) orders.push(mine);
  }
  return { orders, unread, truncated: res.truncated === true };
}

/** Where the chain stands on one order now. */
export type SignedStanding =
  /** Nothing on the chain stops a fill. */
  | 'open'
  /** A match filled part of it; the rest under its ceiling can still be
   *  filled until it lapses or is cancelled. */
  | 'partly-filled'
  /** Its whole ceiling is marked filled: filled, or cancelled (one mark for
   *  both). */
  | 'used'
  /** The signer cancelled every order carrying this nonce. */
  | 'nonce-cancelled'
  /** Its expiry or its signature's deadline has passed on the chain's clock. */
  | 'lapsed'
  | 'unread';

/** Whether the chain would still let someone fill some of the order. */
export function fillable(s: SignedStanding | undefined): boolean {
  return s === 'open' || s === 'partly-filled';
}

/** The chain's own rule: an order is spent only when its cumulative fill
 *  reaches its ceiling (a cancel writes the ceiling); a fill below it is
 *  a partial match, and the rest stays fillable. */
export function standingOf(order: SignedOrderWire, filled: bigint | null, nonceUsed: boolean | null, chainNow: number | null): SignedStanding {
  if (filled === null || nonceUsed === null || chainNow === null) return 'unread';
  if (filled >= signedCeiling(order)) return 'used';
  if (nonceUsed) return 'nonce-cancelled';
  const lapse = lapsesAt(order);
  if (lapse !== null && chainNow > lapse) return 'lapsed';
  return filled > 0n ? 'partly-filled' : 'open';
}

/** Each order's standing, read at one block. A view the contract refused
 *  is `unread` for that order alone; a source that failed throws, so the
 *  own rail moves on to its next source (RB-RAILS). */
export async function readSignedStandings(
  c: PublicClient,
  diamond: Hex,
  orders: readonly MySignedOrder[],
  /** The block to read at; the latest when not given. */
  block?: { number: bigint; timestamp: bigint },
): Promise<{ chainNow: number; standings: Map<Hex, SignedStanding>; filled: Map<Hex, bigint> }> {
  const read = block ?? (await c.getBlock({ blockTag: 'latest' }));
  const at = { blockNumber: read.number };
  const chainNow = Number(read.timestamp);
  const ask = <T>(p: Promise<unknown>) => answerOrNull(p as Promise<T>);
  const rows = await Promise.all(
    orders.map(async (o) => {
      const [filled, nonceUsed] = await Promise.all([
        ask<bigint>(c.readContract({ address: diamond, abi: SIGNED_OFFER, functionName: 'signedOfferFilledAmount', args: [o.orderHash], ...at })),
        ask<boolean>(
          c.readContract({ address: diamond, abi: SIGNED_OFFER, functionName: 'isSignedOfferNonceUsed', args: [o.order.signer, BigInt(o.order.nonce)], ...at }),
        ),
      ]);
      return { hash: o.orderHash, standing: standingOf(o.order, filled, nonceUsed, chainNow), filled };
    }),
  );
  const filled = new Map<Hex, bigint>();
  for (const r of rows) if (r.filled !== null) filled.set(r.hash, r.filled);
  return { chainNow, standings: new Map(rows.map((r) => [r.hash, r.standing] as const)), filled };
}

/** Open orders that share a nonce with at least one other open order: one
 *  nonce cancel stops them together. Keyed by the nonce's decimal text. */
export function sharedNonces(orders: readonly MySignedOrder[], standings: ReadonlyMap<Hex, SignedStanding>): Map<string, MySignedOrder[]> {
  const byNonce = new Map<string, MySignedOrder[]>();
  for (const o of orders) {
    if (!fillable(standings.get(o.orderHash))) continue;
    byNonce.set(o.order.nonce, [...(byNonce.get(o.order.nonce) ?? []), o]);
  }
  for (const [nonce, list] of byNonce) if (list.length < 2) byNonce.delete(nonce);
  return byNonce;
}
