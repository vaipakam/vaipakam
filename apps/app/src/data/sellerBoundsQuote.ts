/**
 * #1810 — the two bounds a lender's sale listing records for its seller, read
 * from the chain before they list, so they can be shown what they agree to and
 * held to exactly that.
 *
 * The figures come from `RiskPreviewFacet.quoteSellerBounds`, which is the very
 * computation the listing stores (one function with two callers), and never
 * from arithmetic re-done here: a client that mirrors the rule drifts from it
 * the moment the rule changes, and this one has changed several times (#1801).
 *
 * - `minSellerNet` — the FLOOR: the least the seller comes out with if a buyer
 *   takes the listing at any moment before it ends (the principal the buyer
 *   pays, less the settlement pulled from the seller).
 * - `maxHeld` — the CEILING on what is already set aside for the lender on the
 *   loan. That money goes to the buyer with the position, not to the seller.
 *
 * The listing is sent through `createLoanSaleOfferBound` with the figures the
 * seller reviewed, and the chain refuses it if the figures it would record are
 * WORSE for the seller (`ListingFloorBelowReviewed` /
 * `ListingHeldAboveReviewed`). Two things make an honest quote differ from a
 * naive one, and both only ever LOWER the floor shown, so the reviewed figure
 * is one the listing can actually meet:
 *
 * 1. TIME. The floor is worked out over the listing's whole window, which
 *    starts when the listing transaction is mined, not when the quote is read.
 *    What the sale costs the seller can move in between, so a quote for
 *    "now plus the window" would be refused if the transaction landed a little
 *    later. The quote is therefore taken for a window that runs
 *    `QUOTE_CONFIRM_ALLOWANCE_SECONDS` longer (clamped, as the chain clamps
 *    it, at the loan's due date). A floor over a longer window is never higher,
 *    so any listing mined within that allowance records at least this floor.
 * 2. ROUNDING. The rate-shortfall half of the cost is a difference of two
 *    separately rounded interest figures, which the contract bounds to within
 *    two base units of the true value. Between the quote's block and the
 *    listing's, that rounding can move the recorded floor down by up to two
 *    units, so the reviewed floor is taken two units lower.
 */
import type { PublicClient } from "viem";
import { DIAMOND_ABI_VIEM } from "../contracts/diamond";

/** How long after the quote the listing transaction may be mined and still
 *  meet the reviewed floor: the review itself and the listing transaction. Past it the listing is refused and the seller reviews
 *  again — nothing is listed on worse terms than they saw. */
export const QUOTE_CONFIRM_ALLOWANCE_SECONDS = 1_800n;

/** Base units the reviewed floor is lowered by — the rounding bound described
 *  in the header (`LibSaleListing.TRUNCATION_SLACK`'s reasoning, applied to
 *  the gap between two reads). */
export const QUOTE_ROUNDING_MARGIN = 2n;

export interface SellerBoundsQuote {
  /** The floor the seller reviews and the listing is bound to. */
  readonly minSellerNet: bigint;
  /** What is already set aside for the lender; goes to the buyer. */
  readonly maxHeld: bigint;
  /** The expiry the quote was worked out for (seconds). */
  readonly quotedExpiry: bigint;
  /** The chain time of the block the quote was read at (seconds). */
  readonly quotedAt: bigint;
}

/** The expiry a quote is taken for: the listing's own window plus the
 *  confirmation allowance, clamped at the loan's due date like the chain's
 *  `_boundListingExpiry`. */
export function quoteExpiryFor(
  chainNow: bigint,
  listingSeconds: bigint,
  maturity: bigint,
): bigint {
  const wanted = chainNow + listingSeconds + QUOTE_CONFIRM_ALLOWANCE_SECONDS;
  return wanted < maturity ? wanted : maturity;
}

/** The floor a seller is shown and bound to, from the chain's raw quote. */
export function reviewedFloor(quotedMinSellerNet: bigint): bigint {
  return quotedMinSellerNet > QUOTE_ROUNDING_MARGIN
    ? quotedMinSellerNet - QUOTE_ROUNDING_MARGIN
    : 0n;
}

export async function readSellerBoundsQuote(
  client: PublicClient,
  diamond: `0x${string}`,
  args: {
    loanId: number | string;
    saleRateBps: bigint;
    listingSeconds: bigint;
    /** The loan's due date (seconds). */
    maturity: bigint;
  },
): Promise<SellerBoundsQuote> {
  const block = await client.getBlock({ blockTag: "latest" });
  const quotedExpiry = quoteExpiryFor(
    block.timestamp,
    args.listingSeconds,
    args.maturity,
  );
  const [minSellerNet, maxHeld] = (await client.readContract({
    address: diamond,
    abi: DIAMOND_ABI_VIEM,
    functionName: "quoteSellerBounds",
    args: [BigInt(args.loanId), args.saleRateBps, quotedExpiry],
    blockNumber: block.number,
  })) as readonly [bigint, bigint];
  return {
    minSellerNet: reviewedFloor(minSellerNet),
    maxHeld,
    quotedExpiry,
    quotedAt: block.timestamp,
  };
}
