/**
 * #2421 — is the borrow request a lender is about to fund a REFINANCE
 * request, and does its collateral carry over?
 *
 * A borrower offer tagged with `refinanceTargetLoanId` is not a fresh
 * borrow: a lender's accept chains, in the same transaction, into the
 * payoff and close of the borrower's running loan (RefinanceFacet's
 * accept-and-refinance entry), and the old lender is paid from the
 * BORROWER's wallet. Whether the collateral is a new pledge or the
 * collateral already locked under that loan is the offer's own recorded
 * decision (`refinanceCarryOver`, fixed at creation and read by every
 * later step), so the review reads it rather than guessing from the
 * loan's current state.
 *
 * Read live from the chain, never from the indexer row: the indexer
 * carries the tag but not the carry-over decision, and the review is a
 * consent surface. Until the answer is in, the review is not signable.
 */
import type { Address, PublicClient } from 'viem';
import { copy } from '../content/copy';
import { DIAMOND_ABI_VIEM } from '../contracts/diamond';

export interface RefinanceRequestInfo {
  /** The running loan the accept pays off and closes. */
  targetLoanId: bigint;
  /** The offer's recorded carry-over decision: true when the collateral
   *  already locked under the target loan moves to the new loan in place;
   *  false when the borrower pledged a fresh batch with the offer. */
  carryOver: boolean;
}

/** The refinance facts of an offer, or null for an untagged offer. */
export function refinanceRequestOf(offer: {
  refinanceTargetLoanId: bigint;
  refinanceCarryOver: boolean;
}): RefinanceRequestInfo | null {
  if (offer.refinanceTargetLoanId === 0n) return null;
  return { targetLoanId: offer.refinanceTargetLoanId, carryOver: offer.refinanceCarryOver };
}

export async function readRefinanceRequestLive(
  client: PublicClient,
  diamond: Address,
  offerId: bigint,
): Promise<RefinanceRequestInfo | null> {
  const offer = (await client.readContract({
    address: diamond,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getOfferDetails',
    args: [offerId],
  })) as { refinanceTargetLoanId: bigint; refinanceCarryOver: boolean };
  return refinanceRequestOf(offer);
}

/** What the lender's review says about the collateral backing the loan
 *  they fund. A refinance request's collateral is described from its
 *  recorded decision: carried over from the old loan (not a new pledge),
 *  or a fresh batch, with the old loan's collateral going back to the
 *  borrower when it closes. An untagged offer keeps the plain line. */
export function lenderCollateralLine(
  refinance: RefinanceRequestInfo | null,
  collateral: string,
): string {
  if (!refinance) return copy.offerFlow.receipts.lenderCollateralLock(collateral);
  const loanId = refinance.targetLoanId.toString();
  return refinance.carryOver
    ? copy.offerFlow.receipts.lenderCollateralCarriedOver(collateral, loanId)
    : copy.offerFlow.receipts.lenderCollateralFreshPledge(collateral, loanId);
}
