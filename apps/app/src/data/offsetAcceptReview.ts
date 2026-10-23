/**
 * #2523 — the review a taker sees before accepting a borrower's OFFSET offer
 * (preclose Option 3).
 *
 * An offset offer is an ordinary lender offer in every term the taker signs:
 * the poster lends the loan's principal against the taker's collateral, for
 * the offer's own rate and duration, and the offer's stored fields describe
 * that new loan truthfully. What is different is what ELSE the same
 * transaction does. Accepting it also closes the poster's earlier loan, and
 * that close-out runs inside the taker's transaction:
 *
 * - it is refused unless the earlier loan is still active;
 * - it is refused if the new loan would end after the earlier one's due
 *   date (the term is measured from the moment of acceptance);
 * - it is refused while a swap-to-repay order is stored on the earlier loan;
 * - it pays the earlier loan's lender from the POSTER's wallet, on the
 *   standing approval the poster gave when posting, so a revoked approval or
 *   a spent balance fails it.
 *
 * Any of those reverts the whole acceptance. Nothing moves, but the taker
 * spends the network fee on a doomed transaction and sees an opaque
 * failure. So the review reads each of them live, from the chain, and the
 * accept is signable only when every one is POSITIVELY clear. An answer it
 * could not read blocks too, and says so. The rule for the poster's
 * funding is the one the poster's own card watches (`offsetCompletionBoundOf`),
 * so the two parties are told the same thing.
 */
import type { PublicClient } from "viem";
import { erc20Abi } from "viem";
import { DIAMOND_ABI_VIEM } from "../contracts/diamond";
import {
  LOAN_STATUS_ACTIVE,
  loanEndTimeOf,
  offsetCompletionBoundOf,
  readLoanLive,
  type LoanLive,
} from "../contracts/loanLive";
import { swapToRepayOrderState } from "./partialWithdraw";

/** LibVaipakam.OfferType.Lender. */
const OFFER_TYPE_LENDER = 0;

export type OffsetReview =
  /** The link is not an offset this review can vouch for (a lender-type
   *  linked offer whose creator is not the earlier loan's borrower). The
   *  accept stays blocked. */
  | { kind: "other" }
  /** The earlier loan has already ended (repaid, defaulted, settled). The
   *  completion refuses any acceptance whose linked loan is not active, so
   *  this is decided by the loan's status alone: nothing else about the
   *  offer is read, and its borrower NFT may already be burned by a claim
   *  (Codex #2675 r1). */
  | { kind: "loan-ended"; loanId: string; live: LoanLive }
  | {
      kind: "offset";
      /** The earlier loan the acceptance closes. */
      loanId: string;
      live: LoanLive;
      /** Who posted the offer, and who pays the close-out. */
      poster: `0x${string}`;
      /** The earlier loan's due date (seconds). */
      dueAtSec: bigint;
      /** The new loan, started now, still ends by that due date. */
      termFits: boolean;
      /** The poster's standing approval AND wallet balance cover the most
       *  the close-out can pull. */
      posterCovered: boolean;
      /** A swap-to-repay order on the earlier loan; `unknown` when the
       *  read failed. */
      swapOrder: "live" | "none" | "unknown";
    };

/** Why an offset acceptance cannot be signed, or null when it can. Order
 *  only picks which reason is shown: the most structural first. */
export type OffsetReviewBlock =
  | "not-offset"
  | "loan-not-active"
  | "term-passed"
  | "swap-order"
  | "swap-order-unknown"
  | "poster-not-covered";

export function offsetReviewBlock(
  review: OffsetReview,
): OffsetReviewBlock | null {
  if (review.kind === "loan-ended") return "loan-not-active";
  if (review.kind !== "offset") return "not-offset";
  if (!review.termFits) return "term-passed";
  if (review.swapOrder === "live") return "swap-order";
  if (review.swapOrder === "unknown") return "swap-order-unknown";
  if (!review.posterCovered) return "poster-not-covered";
  return null;
}

/** What the review's consent is given against: every input to the verdict
 *  above, so a change in any of them voids an earlier tick. */
export function offsetReviewFingerprint(
  review: OffsetReview | undefined,
): string {
  if (review === undefined) return "?";
  if (review.kind === "loan-ended")
    return ["ended", review.loanId, review.live.status].join(":");
  if (review.kind !== "offset") return "other";
  return [
    review.loanId,
    review.live.status,
    review.termFits ? 1 : 0,
    review.swapOrder,
    review.posterCovered ? 1 : 0,
  ].join(":");
}

export async function readOffsetReviewLive(
  client: PublicClient,
  diamondAddress: `0x${string}`,
  offerId: number | string,
  loanId: string,
): Promise<OffsetReview> {
  const [offer, live] = await Promise.all([
    client.readContract({
      address: diamondAddress,
      abi: DIAMOND_ABI_VIEM,
      functionName: "getOfferDetails",
      args: [BigInt(offerId)],
    }) as Promise<{
      creator: `0x${string}`;
      offerType: number | bigint;
      durationDays: number | bigint;
    }>,
    readLoanLive(client, diamondAddress, BigInt(loanId)),
  ]);
  // An ended loan settles the verdict before anything else is read: the
  // completion refuses it whatever the offer's shape, and once the borrower
  // has claimed, the borrower NFT the shape check reads no longer exists, so
  // reading on would turn a known answer into a failed read.
  if (live.status !== LOAN_STATUS_ACTIVE) {
    return { kind: "loan-ended", loanId, live };
  }
  // The offset path creates the offer AS the earlier loan's borrower-NFT
  // holder, and that NFT is locked until the offset completes or is
  // cancelled, so the two must agree. Anything else is not a shape this
  // review describes.
  const currentBorrower = (await client.readContract({
    address: diamondAddress,
    abi: DIAMOND_ABI_VIEM,
    functionName: "ownerOf",
    args: [live.borrowerTokenId],
  })) as `0x${string}`;
  if (
    Number(offer.offerType) !== OFFER_TYPE_LENDER ||
    offer.creator.toLowerCase() !== currentBorrower.toLowerCase()
  ) {
    return { kind: "other" };
  }
  const poster = offer.creator;
  const dueAtSec = loanEndTimeOf(live);
  // The completion's anti-drift rule, at the chain time of the block the
  // loan was read at (one snapshot, never a timestamp from another block). The new
  // loan starts when the acceptance mines, so an offer at the very edge can
  // still be refused a little later; its own expiry is stamped at the last
  // acceptable moment and the submit re-reads this before signing.
  const termFits =
    live.readAtTimestamp + BigInt(offer.durationDays) * 86_400n <= dueAtSec;
  const bound = offsetCompletionBoundOf(live);
  const [allowance, balance, swapOrder] = await Promise.all([
    client.readContract({
      address: live.principalAsset,
      abi: erc20Abi,
      functionName: "allowance",
      args: [poster, diamondAddress],
    }) as Promise<bigint>,
    client.readContract({
      address: live.principalAsset,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [poster],
    }) as Promise<bigint>,
    swapToRepayOrderState({
      publicClient: client,
      diamondAddress,
      loanId: BigInt(loanId),
    }),
  ]);
  return {
    kind: "offset",
    loanId,
    live,
    poster,
    dueAtSec,
    termFits,
    // Nothing reaches the poster earlier in the acceptance (the principal
    // the taker receives was escrowed when the offer was posted), so the
    // balance must cover the pull on its own.
    posterCovered: allowance >= bound && balance >= bound,
    swapOrder,
  };
}
