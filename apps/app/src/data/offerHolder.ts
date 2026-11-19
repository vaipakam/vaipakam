/**
 * #3744 — who an open offer belongs to now.
 *
 * An offer's position token decides its value: whoever holds that token
 * takes the creator's side of the loan when it fills, gets the escrow back
 * when it is cancelled, edited down or returned by a fill, and is the one
 * who may edit or cancel it. The creator keeps none of that once the token
 * has moved; only the creator, while it still holds the token, may raise the
 * escrow (the raise is pulled from its own wallet into its own vault).
 *
 * The holder comes from the indexer's Transfer record (`IndexedOffer.holder`)
 * or from the chain read that built the row. When neither knows, the answer
 * is `null`: unknown, never "the creator", so no surface offers a step it
 * cannot stand behind. The contract enforces the rule either way
 * (`NotOfferHolder`).
 */
import type { IndexedOffer } from './indexer';

const ZERO = '0x0000000000000000000000000000000000000000';

type HolderFields = Pick<IndexedOffer, 'creator' | 'positionTokenId' | 'holder'>;

/** The holder of the offer's position token, lower-cased; the zero address
 *  when the token is retired; `null` when unknown. An offer minted without a
 *  position token is its creator's. */
export function offerHolder(offer: HolderFields): string | null {
  if (String(offer.positionTokenId) === '0') return offer.creator.toLowerCase();
  const h = offer.holder;
  if (typeof h !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(h)) return null;
  return h.toLowerCase();
}

/** Whether `address` holds the offer's position token: `true`, `false`, or
 *  `null` when the holder is not known. Gate a step on `=== true`. */
export function isOfferHolder(offer: HolderFields, address: string | undefined | null): boolean | null {
  if (!address) return false;
  const h = offerHolder(offer);
  if (h === null) return null;
  if (h === ZERO) return false;
  return h === address.toLowerCase();
}

/** Whether `address` may raise the offer's escrow: it created the offer and
 *  still holds its token. */
export function canRaiseOfferEscrow(offer: HolderFields, address: string | undefined | null): boolean {
  return (
    Boolean(address) &&
    offer.creator.toLowerCase() === address!.toLowerCase() &&
    isOfferHolder(offer, address) === true
  );
}

/** Whether the offer is `address`'s own for TAKING purposes: it created it
 *  or holds its token. The contract refuses both (a loan whose two sides
 *  would belong to one wallet), so neither is offered as a counterparty. */
export function isOwnOffer(offer: HolderFields, address: string | undefined | null): boolean {
  if (!address) return false;
  return offer.creator.toLowerCase() === address.toLowerCase() || isOfferHolder(offer, address) === true;
}

/** True when the token has moved away from the creator to another wallet. */
export function offerHeldByOther(offer: HolderFields): boolean {
  const h = offerHolder(offer);
  return h !== null && h !== ZERO && h !== offer.creator.toLowerCase();
}
