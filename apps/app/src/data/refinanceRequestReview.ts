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
import {
  BaseError,
  ContractFunctionRevertedError,
  zeroAddress,
  type Address,
  type PublicClient,
} from 'viem';
import { copy } from '../content/copy';
import { DIAMOND_ABI_VIEM } from '../contracts/diamond';
import { isMissingSelectorError } from '../contracts/preflights';
import { submitErrorText } from '../lib/errors';

/**
 * Whether the request can be taken NOW (Codex #2668 r1).
 *
 * The offer's tag and carry-over decision are fixed when it is posted, but
 * the loan it targets keeps moving: a full repayment or an enforcement can
 * close it, and adding collateral breaks a carry-over request's exact match
 * — the on-chain guard deliberately allows all three, which leaves the
 * request unfillable. So the review asks `checkRefinanceRequest`, the
 * acceptance check the contract itself re-runs, before it describes the
 * refinance as something accepting will do:
 *  - `takeable` — the check passed; the lifecycle claims stand.
 *  - `blocked` — the check reverted; `reason` is the decoded revert, and the
 *    review says the request cannot be taken and offers nothing to sign.
 *  - `unchecked` — this Diamond has no such view, so the app cannot vouch
 *    either way; the review says so, and the accept's own on-chain check is
 *    what stops a stale request.
 */
export type RefinanceRequestStanding =
  | { kind: 'takeable' }
  | { kind: 'blocked'; reason: string }
  | { kind: 'unchecked' };

export interface RefinanceRequestInfo {
  /** The running loan the accept pays off and closes. */
  targetLoanId: bigint;
  /** The offer's recorded carry-over decision: true when the collateral
   *  already locked under the target loan moves to the new loan in place;
   *  false when the borrower pledged a fresh batch with the offer. */
  carryOver: boolean;
  standing: RefinanceRequestStanding;
}

/** The refinance facts of an offer, or null for an untagged offer. */
export function refinanceRequestOf(
  offer: {
    refinanceTargetLoanId: bigint;
    refinanceCarryOver: boolean;
  },
  standing: RefinanceRequestStanding = { kind: 'takeable' },
): RefinanceRequestInfo | null {
  if (offer.refinanceTargetLoanId === 0n) return null;
  return {
    targetLoanId: offer.refinanceTargetLoanId,
    carryOver: offer.refinanceCarryOver,
    standing,
  };
}

/** Classify a failed `checkRefinanceRequest` read. A missing view is
 *  `unchecked`; any other contract revert is the acceptance check saying
 *  no; anything else (transport, RPC) is not an answer and is rethrown, so
 *  the review shows its check-failed state with a retry. */
export function standingFromCheckError(err: unknown): RefinanceRequestStanding {
  if (isMissingSelectorError(err)) return { kind: 'unchecked' };
  const reverted =
    err instanceof BaseError &&
    err.walk((e) => e instanceof ContractFunctionRevertedError) !== null;
  if (!reverted) throw err;
  return { kind: 'blocked', reason: submitErrorText(err) };
}

/** Whether a fresh read still says what the lender reviewed: the same
 *  target, the same collateral decision and the same standing (Codex #2668
 *  r2). A blocked review never reaches submit, so a blocked reason that
 *  merely reworded is not a difference worth refusing on. */
export function sameRefinanceReview(
  reviewed: RefinanceRequestInfo | null,
  live: RefinanceRequestInfo | null,
): boolean {
  if (reviewed === null || live === null) return reviewed === live;
  return (
    reviewed.targetLoanId === live.targetLoanId &&
    reviewed.carryOver === live.carryOver &&
    reviewed.standing.kind === live.standing.kind
  );
}

/** The target already known for an offer: the last answer this review had,
 *  else the indexed row's tag (Codex #2668 r3). 0n when neither knows of one. */
export function knownRefinanceTarget(
  previous: RefinanceRequestInfo | null | undefined,
  indexedTag: number | null | undefined,
): bigint {
  if (previous) return previous.targetLoanId;
  return indexedTag && indexedTag > 0 ? BigInt(indexedTag) : 0n;
}

/**
 * Read an offer's refinance facts and whether the request can be taken now.
 *
 * `knownTargetLoanId` is the target the caller already has for this offer
 * (the indexed row's tag, or the reviewed answer) — 0n or undefined when it
 * has none. It matters only when the offer no longer exists on-chain:
 * cancelling deletes the offer, and a deleted offer reads back zeroed,
 * which on its own is indistinguishable from an untagged borrow request
 * (Codex #2668 r3). A request the caller knew as a refinance therefore
 * comes back BLOCKED rather than as an ordinary offer.
 */
export async function readRefinanceRequestLive(
  client: PublicClient,
  diamond: Address,
  offerId: bigint,
  knownTargetLoanId?: bigint,
): Promise<RefinanceRequestInfo | null> {
  const offer = (await client.readContract({
    address: diamond,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getOfferDetails',
    args: [offerId],
  })) as {
    creator: Address;
    refinanceTargetLoanId: bigint;
    refinanceCarryOver: boolean;
  };
  if (offer.creator === zeroAddress) {
    if (!knownTargetLoanId) return null;
    return {
      targetLoanId: knownTargetLoanId,
      // The deleted record no longer says; a blocked review renders no
      // collateral line, so nothing is stated from this placeholder.
      carryOver: false,
      standing: { kind: 'blocked', reason: copy.match.refinanceRequestGone },
    };
  }
  if (offer.refinanceTargetLoanId === 0n) return null;
  let standing: RefinanceRequestStanding;
  try {
    await client.readContract({
      address: diamond,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'checkRefinanceRequest',
      args: [offer.refinanceTargetLoanId, offerId],
    });
    standing = { kind: 'takeable' };
  } catch (err) {
    standing = standingFromCheckError(err);
  }
  return refinanceRequestOf(offer, standing);
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
