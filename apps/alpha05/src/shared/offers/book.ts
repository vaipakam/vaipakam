/**
 * OFF-39, OFF-40 — the offer book: every open offer on the chain, newest
 * first, as the indexer files it (the world rail, RB-RAILS). The index only
 * NAMES candidates: an offer's state and terms are read from the chain on
 * its detail page before anything is offered (OFF-41), so a row here never
 * carries an action of its own.
 *
 * What the index cannot establish is said, never guessed: a lapsed offer
 * still filed as active is shown as expired (expiry is lazy on-chain), a
 * row whose answer does not have the expected shape is counted as unread
 * instead of being dropped, and a failed read is a degraded-source warning,
 * never an empty book.
 */
import { getAddress } from 'viem';
import { ASSET_ERC20, OFFER_TYPE_LENDER } from '../positions/model';
import type { IndexerClient } from '../reads/world/indexerClient';
import type { OfferLineFields } from './offerLine';

type Hex = `0x${string}`;

/** How many offers one read of the book covers. */
export const BOOK_PAGE = 50;

/** What an offer is for, as the index records it. `refinance-unknown`: the
 *  index has not read whether it is a refinance request. A loan sale buys a
 *  running loan's lender position; an offset closes a borrower's loan early
 *  by handing it to whoever takes the offer. */
export type BookKind = 'plain' | 'refinance' | 'refinance-unknown' | 'loan-sale' | 'offset';

export interface BookRow extends OfferLineFields {
  creator: Hex;
  collateralAssetType: number;
  collateralAsset: Hex;
  collateralAmount: bigint;
  /** A borrower request's collateral ceiling; null when the index has not
   *  read it (#2382). A lender offer's is its amount. */
  collateralAmountMax: bigint | null;
  collateralTokenId: bigint;
  amountFilled: bigint;
  /** 0 = never expires. */
  expiresAt: bigint;
  kind: BookKind;
  /** #3205: the offer is bound to a loan position that moved since it
   *  opened, so it can never complete. Null when the index cannot tell. */
  moved: boolean | null;
}

export interface BookPage {
  rows: BookRow[];
  /** Rows the index returned that this app could not read. */
  unread: number;
  /** Where the next, older page starts; null at the end of the book. */
  nextBefore: string | null;
}

type Json = Record<string, unknown>;

const HEX = /^0x[0-9a-fA-F]{40}$/;

function big(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  throw new Error('not a whole number');
}

function addr(v: unknown): Hex {
  // The index stores addresses lowercased; shown in checksum form, as
  // every other address on the page is.
  if (typeof v === 'string' && HEX.test(v)) return getAddress(v);
  throw new Error('not an address');
}

function kindOf(o: Json, offerType: number): BookKind {
  if (o.isSaleVehicle === true) return 'loan-sale';
  if (o.isOffsetVehicle === true) return 'offset';
  // Only a borrowing request can ask to refinance.
  if (offerType === OFFER_TYPE_LENDER) return 'plain';
  const target = o.refinanceTargetLoanId;
  if (target === null || target === undefined) return 'refinance-unknown';
  return big(target) > 0n ? 'refinance' : 'plain';
}

function movedOf(o: Json): boolean | null {
  const flow = o.positionFlow as { movedSinceOpened?: unknown } | null | undefined;
  if (flow === null) return false;
  return flow?.movedSinceOpened === true ? true : flow?.movedSinceOpened === false ? false : null;
}

/** One indexer row as a book row; throws on any field it cannot read. */
export function bookRowFrom(o: Json): BookRow {
  const offerType = Number(big(o.offerType));
  return {
    id: big(o.offerId),
    creator: addr(o.creator),
    offerType,
    assetType: Number(big(o.assetType)),
    collateralAssetType: Number(big(o.collateralAssetType)),
    lendingAsset: addr(o.lendingAsset),
    collateralAsset: addr(o.collateralAsset),
    amount: big(o.amount),
    amountMax: big(o.amountMax),
    amountFilled: big(o.amountFilled),
    interestRateBps: big(o.interestRateBps),
    interestRateBpsMax: big(o.interestRateBpsMax),
    collateralAmount: big(o.collateralAmount),
    collateralAmountMax:
      offerType === OFFER_TYPE_LENDER ? big(o.collateralAmount) : o.collateralAmountMax === null || o.collateralAmountMax === undefined ? null : big(o.collateralAmountMax),
    durationDays: big(o.durationDays),
    tokenId: big(o.tokenId),
    collateralTokenId: big(o.collateralTokenId),
    prepayAsset: addr(o.prepayAsset),
    expiresAt: big(o.expiresAt),
    kind: kindOf(o, offerType),
    moved: movedOf(o),
  };
}

/** One page of the book, newest first, older than `before` when given.
 *  Throws (the indexer's own failure) when the index does not answer. */
export async function readBookPage(indexer: IndexerClient, chainId: number, before: string | null, limit = BOOK_PAGE): Promise<BookPage> {
  const q = new URLSearchParams({ chainId: String(chainId), limit: String(limit) });
  if (before !== null) q.set('before', before);
  const res = await indexer.getJson<{ offers?: unknown; nextBefore?: unknown }>(`/offers/active?${q.toString()}`);
  if (!Array.isArray(res.offers)) throw new Error('The index answered without an offer list.');
  const rows: BookRow[] = [];
  let unread = 0;
  for (const o of res.offers) {
    try {
      rows.push(bookRowFrom(o as Json));
    } catch {
      unread += 1;
    }
  }
  const next = res.nextBefore;
  return { rows, unread, nextBefore: typeof next === 'number' || typeof next === 'string' ? String(next) : null };
}

/** The book's two tabs: loans of an ERC-20, and NFT rentals. */
export const BOOK_TABS = ['loans', 'rentals'] as const;
export type BookTab = (typeof BOOK_TABS)[number];

/** Which side's offers to show: lenders' offers, borrowers' requests, or both. */
export const BOOK_SIDES = ['all', 'lender', 'borrower'] as const;
export type BookSide = (typeof BOOK_SIDES)[number];

export interface BookFilter {
  tab: BookTab;
  side: BookSide;
  /** The connected wallet, when its own offers are hidden. */
  hide: Hex | null;
}

export function inBook(r: BookRow, f: BookFilter): boolean {
  if ((r.assetType === ASSET_ERC20) !== (f.tab === 'loans')) return false;
  if (f.side === 'lender' && r.offerType !== OFFER_TYPE_LENDER) return false;
  if (f.side === 'borrower' && r.offerType === OFFER_TYPE_LENDER) return false;
  if (f.hide !== null && r.creator.toLowerCase() === f.hide.toLowerCase()) return false;
  return true;
}

/** An offer the index still files as active though its expiry has passed:
 *  nobody can accept it, and anyone may clean it up. */
export function lapsed(r: Pick<BookRow, 'expiresAt'>, nowSec: number): boolean {
  return r.expiresAt > 0n && r.expiresAt <= BigInt(Math.floor(nowSec));
}
