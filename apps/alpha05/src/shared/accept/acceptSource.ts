/**
 * OFF-50 / OFF-60 — what an acceptance takes: an offer stored on the chain
 * (by its id), or a maker's signed order from the offer book, which has no
 * id until its fill writes one. One review and one flow serve both; this is
 * the one place that tells them apart by key and by name.
 */
import type { BookSignedOrder } from '../desk/signedBook';
import { shortAddress } from '../ui/format';

export type AcceptSource = { kind: 'stored'; offerId: bigint } | { kind: 'signed'; order: BookSignedOrder };

export function storedSource(offerId: bigint): AcceptSource {
  return { kind: 'stored', offerId };
}

/** A stable key for the subject of a review: a review read for one source
 *  never lands on another's. */
export function sourceKey(s: AcceptSource): string {
  return s.kind === 'stored' ? `offer:${s.offerId.toString()}` : `signed:${s.order.orderHash.toLowerCase()}`;
}

/** How a page names the subject: the offer's number, or the order's
 *  shortened hash. */
export function sourceLabel(s: AcceptSource): string {
  return s.kind === 'stored' ? s.offerId.toString() : shortAddress(s.order.orderHash);
}
