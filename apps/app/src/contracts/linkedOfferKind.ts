/**
 * Which auto-linked vehicle a linked offer is (#2523, Codex #2675 r1).
 *
 * An offer with a non-zero `getOfferLinkedLoanId` is one of two vehicles, and
 * the contract keeps them in two separate links: a lender's sale listing is
 * the BORROWER-type offer it creates (`saleOfferToLoanId`), and a borrower's
 * offset is the LENDER-type offer it creates (`offsetOfferToLoanId`). Only the
 * sale link makes the acceptance bind to the linked loan's live principal,
 * term and collateral; an offset binds to the offer's own fields. So the
 * offer's own side of the book names the link exactly.
 *
 * Never tell the two apart by comparing the creator with the loan's lender or
 * borrower: one wallet can hold both sides of a loan, and its offset would
 * then read as a sale and sign terms the contract rejects. Every surface that
 * needs to know which vehicle it is looking at reads this one rule.
 */

/** LibVaipakam.OfferType.Borrower — the side a sale listing is posted on. */
const OFFER_TYPE_BORROWER = 1;

export type LinkedOfferKind = 'sale' | 'offset';

export function linkedOfferKind(offerType: number | bigint): LinkedOfferKind {
  return Number(offerType) === OFFER_TYPE_BORROWER ? 'sale' : 'offset';
}
