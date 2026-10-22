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
import { friendlyContractError } from '@vaipakam/lib';
import { copy } from '../content/copy';
import { DIAMOND_ABI_VIEM } from '../contracts/diamond';
import { isMissingSelectorError } from '../contracts/preflights';
import { submitErrorText, translateContractError } from '../lib/errors';

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

/**
 * What the chain says about an offer the lender is reviewing (Codex #2668
 * r3/r5). Three answers, never conflated:
 *  - `ordinary` — the offer exists and carries no refinance tag;
 *  - `refinance` — the offer exists and asks to refinance a running loan;
 *  - `gone` — the offer no longer exists. Cancelling deletes an offer, and a
 *    deleted offer reads back zeroed, which on its face looks like an
 *    untagged request. It is its own answer so the review can never
 *    describe a deleted offer as a live ordinary one, whether or not anyone
 *    knew it as a refinance.
 */
export type RefinanceReviewRead =
  | { kind: 'ordinary' }
  | { kind: 'gone' }
  | { kind: 'refinance'; info: RefinanceRequestInfo };

/** Whether a fresh read still says what the lender reviewed: the same
 *  answer and, for a refinance, the same target, collateral decision and
 *  standing (Codex #2668 r2). A blocked review never reaches submit, so a
 *  blocked reason that merely reworded is not a difference worth refusing
 *  on. */
export function sameRefinanceReview(
  reviewed: RefinanceReviewRead,
  live: RefinanceReviewRead,
): boolean {
  if (reviewed.kind !== 'refinance' || live.kind !== 'refinance') {
    return reviewed.kind === live.kind;
  }
  return (
    reviewed.info.targetLoanId === live.info.targetLoanId &&
    reviewed.info.carryOver === live.info.carryOver &&
    reviewed.info.standing.kind === live.info.standing.kind
  );
}

/**
 * Read an offer's refinance facts and whether the request can be taken now.
 *
 * Every read is pinned to ONE block (Codex #2668 r5): the answer is
 * assembled from several views, and unpinned they could straddle a cancel
 * or a repayment and combine a state from before it with one from after.
 */
export async function readRefinanceRequestLive(
  client: PublicClient,
  diamond: Address,
  offerId: bigint,
): Promise<RefinanceReviewRead> {
  const blockNumber = await client.getBlockNumber();
  const offer = (await client.readContract({
    address: diamond,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getOfferDetails',
    args: [offerId],
    blockNumber,
  })) as {
    creator: Address;
    refinanceTargetLoanId: bigint;
    refinanceCarryOver: boolean;
  };
  if (offer.creator === zeroAddress) return { kind: 'gone' };
  if (offer.refinanceTargetLoanId === 0n) return { kind: 'ordinary' };
  const standing = await readStanding(
    client,
    diamond,
    offer.refinanceTargetLoanId,
    offerId,
    blockNumber,
  );
  return {
    kind: 'refinance',
    info: {
      targetLoanId: offer.refinanceTargetLoanId,
      carryOver: offer.refinanceCarryOver,
      standing,
    },
  };
}

/** Mirror the two checks acceptance makes. `checkRefinanceRequest` covers
 *  the request's own state and the target loan; it deliberately does not
 *  check that the offer is the loan's RECORDED request, which acceptance
 *  also requires (Codex #2668 r4) — a request posted before the record
 *  existed, or one displaced by a later request, passes the first check and
 *  is still refused. So the record is compared too, and its own `live`
 *  verdict honoured (r5). */
async function readStanding(
  client: PublicClient,
  diamond: Address,
  loanId: bigint,
  offerId: bigint,
  blockNumber: bigint,
): Promise<RefinanceRequestStanding> {
  try {
    await client.readContract({
      address: diamond,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'checkRefinanceRequest',
      args: [loanId, offerId],
      blockNumber,
    });
  } catch (err) {
    return standingFromCheckError(err);
  }
  let recorded: readonly [bigint, boolean];
  try {
    recorded = (await client.readContract({
      address: diamond,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'getRefinanceRequest',
      args: [loanId],
      blockNumber,
    })) as readonly [bigint, boolean];
  } catch (err) {
    if (isMissingSelectorError(err)) return { kind: 'unchecked' };
    throw err;
  }
  const [recordedOfferId, live] = recorded;
  if (recordedOfferId !== offerId) {
    return { kind: 'blocked', reason: contractReason('RefinanceRequestNotRecorded') };
  }
  if (!live) {
    return { kind: 'blocked', reason: contractReason('RefinanceRequestNotLive') };
  }
  return { kind: 'takeable' };
}

/** The curated, translated text for a refusal the views report as a flag
 *  rather than a revert. */
function contractReason(name: string): string {
  return friendlyContractError({ name }, translateContractError) ?? copy.errors.txFailed;
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
