/**
 * The per-loan refinance-request plan (#126 slice 3) — ONE copy of the
 * live checks a borrower's refinance request runs before anything is
 * signed, shared by the loan page's refinance form and the "Refinance
 * all" batch on Positions.
 *
 * Before this module the checks lived inline in `RefinanceFlow.submit`. A
 * batch that restated them would be a second copy of the rule, and the
 * copies would drift — the reason the close-out and listing checks moved
 * into `closeOutPlan.ts` and `saleListingPlan.ts`.
 *
 * What a plan is: the request to post (its `createOffer` payload with a
 * hard expiry), the guardrail write it needs first when the loan's
 * auto-refinance caps do not already cover it, and the figures the
 * borrower reviews — today's payoff, what the wallet must hold spare at
 * acceptance, and the standing approval the acceptance pulls against,
 * sized to the wallet's share of the payoff at the request's LAST
 * fillable moment (#1236, #3042: the new loan's net principal pays the
 * rest inside the Diamond).
 * Or the reason the loan cannot take a request now.
 *
 * What a plan is NOT: the guardrail write, a balance check or an
 * approval. A batch checks the wallet against the SUM of its loans'
 * spare amounts and approves the sum of their bounds once, so all three
 * stay with the caller.
 *
 * Read failures THROW, as the inline checks did; a caller that plans many
 * loans turns a throw into that loan's refusal (`planRefinanceForBatch`).
 */
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { copy } from '../content/copy';
import { captureTxError } from '../lib/errors';
import { formatDate } from '../lib/format';
import { AssetType, LoanStatus } from '../lib/types';
import { toRefinanceOfferPayload, type CreateOfferPayload } from '../lib/offerSchema';
import {
  LOAN_STATUS_ACTIVE,
  loanEndTimeOf,
  readLoanLive,
  refinanceApprovalOf,
  refinancePayoffOf,
  refinanceWalletPullOf,
  type LoanLive,
} from '../contracts/loanLive';
import {
  assertAssetNotPausedLive,
  assertPositionNftHeldLive,
  readGraceSecondsLive,
} from '../contracts/preflights';
import { assertWalletNotSanctionedLive } from './sanctions';
import { readLiveProtocolFees, type ProtocolFees } from './fees';
import { discoverRefinanceRequest } from './refinanceDiscovery';
import { postRefinanceVerdict } from './refinanceInterlock';
import {
  offsetLockRefusal,
  saleSettlementRefusal,
  type CloseOutCtx,
  type CloseOutLoan,
} from './closeOutPlan';

/** The request's on-chain lifetime (its `expiresAt`), and the extra
 *  headroom the caps' end-date window carries past the new-loan duration.
 *  Disclosed in the review; enforced by the OFFER's own expiry (accept
 *  refuses an expired offer), so it holds even when looser caps
 *  pre-exist. */
export const REQUEST_WINDOW_DAYS = 30n;

/** The loan fields a plan reads — a subset of the indexer row. */
export interface RefinanceLoan extends CloseOutLoan {
  collateralAsset: string;
}

export type RefinanceCtx = CloseOutCtx;

/** What the borrower chose: the same for every loan in a batch. */
export interface RefinanceTerms {
  /** The highest yearly rate the replacement may carry, in basis points. */
  rateBps: number;
  durationDays: number;
}

/** The fee config the review quoted. */
export type ReviewedFees = Pick<
  ProtocolFees,
  'treasuryFeeBps' | 'loanInitiationFeeBps' | 'maxOfferDurationDays'
>;

export interface RefinanceRequestReady {
  kind: 'ready';
  loanId: number;
  liveLoan: LoanLive;
  /** Chain time of the block the plan was judged at. */
  chainNow: bigint;
  /** Today's payoff to the old lender. */
  payoff: bigint;
  /** What the wallet must hold spare at acceptance, and what the accept
   *  pulls from it: the payoff less the new loan's net principal, which
   *  pays the old lender inside the Diamond (#3042) — the interest share
   *  plus the new loan's initiation fee. Judged at today's payoff. */
  topUp: bigint;
  /** The standing approval the acceptance pulls against: the wallet's
   *  share at the request's last fillable moment, at the live fee rate
   *  with no discount (an upper bound; a discount only lowers the pull). */
  approval: bigint;
  /** How much the payoff can still grow before the request's last
   *  fillable moment (late fee and interest); 0 when it cannot. */
  headroom: bigint;
  /** The request's own expiry, and whether the chain will clamp it to
   *  the grace end (the honest reviewed lifetime is then the grace end). */
  requestExpiry: bigint;
  graceEnd: bigint;
  expiryGraceClamped: boolean;
  /** Past the due date, inside grace: the payoff carries the late fee. */
  pastDue: boolean;
  /** The guardrail write the request needs first, or null when the
   *  loan's caps already cover it. */
  caps: { rateBps: number; maxNewExpiry: bigint } | null;
  /** The request itself, consent given. */
  payload: CreateOfferPayload;
}

export interface RefinanceRefusal {
  kind: 'refused';
  loanId: number;
  reason: string;
  /** The live fee config no longer matches the one reviewed. */
  feesMoved: boolean;
}

const refusal = (loanId: number, reason: string, feesMoved = false): RefinanceRefusal => ({
  kind: 'refused',
  loanId,
  reason,
  feesMoved,
});

/**
 * The checks a refinance request runs immediately before it is signed.
 * A refusal the preflights raise (sanctions, the position NFT not held, a
 * paused asset) and every failed read THROW.
 */
export async function checkRefinanceRequest(
  ctx: RefinanceCtx,
  loan: RefinanceLoan,
  terms: RefinanceTerms,
  reviewedFees: ReviewedFees,
): Promise<RefinanceRequestReady | RefinanceRefusal> {
  const { publicClient, diamond, holder } = ctx;
  // createOffer + the accept-time refinance are Tier-1 — live re-screen
  // before anything can mine.
  await assertWalletNotSanctionedLive(publicClient, diamond, holder);
  // Live state, one round-trip: current holdership (refinance authority
  // follows the borrower NFT), the loan itself (the payload copies its
  // collateral identity VERBATIM — stale values would break carry-over),
  // chain time, the existing guardrails, live fees (the review quoted a
  // cached config), and both legs' pause state.
  const [, liveLoan, latestBlock, caps, liveFees] = await Promise.all([
    assertPositionNftHeldLive({
      publicClient,
      diamondAddress: diamond,
      tokenId: loan.borrowerTokenId,
      expectedOwner: holder,
    }),
    readLoanLive(publicClient, diamond, loan.loanId),
    publicClient.getBlock({ blockTag: 'latest' }),
    publicClient.readContract({
      address: diamond,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'getAutoRefinanceCaps',
      args: [BigInt(loan.loanId)],
    }) as Promise<{ enabled: boolean; maxRateBps: number; maxNewExpiry: bigint }>,
    readLiveProtocolFees(publicClient, diamond),
    assertAssetNotPausedLive({
      publicClient,
      diamondAddress: diamond,
      asset: loan.lendingAsset as `0x${string}`,
    }),
    assertAssetNotPausedLive({
      publicClient,
      diamondAddress: diamond,
      asset: loan.collateralAsset as `0x${string}`,
    }),
  ]);
  if (liveLoan.status !== LOAN_STATUS_ACTIVE) {
    // A loan in its fallback period is not settled; saying so would send
    // the borrower looking for a close that never happened.
    return refusal(
      loan.loanId,
      Number(liveLoan.status) === LoanStatus.FallbackPending
        ? copy.refinance.inFallback
        : copy.errors.loanAlreadySettled,
    );
  }
  // Carry-over binds to the ORIGINAL borrower: the contract compares the
  // offer creator to the borrower stored at loan init, not the current
  // position holder, so for a transferred position the same offer would
  // become a fresh collateral pledge from the poster's wallet.
  if (liveLoan.borrower.toLowerCase() !== holder.toLowerCase()) {
    return refusal(loan.loanId, copy.errors.refinanceNotOriginalBorrower);
  }
  // #1189/#1236 — the admission gate blocks only STRICTLY past the grace
  // window (an in-grace request is valid; its accept charges the late
  // fee). Judged on the LIVE term and grace bucket, mirroring
  // LibAutoRefinanceCheck, against the EFFECTIVE due date (#668 / #935).
  const graceSeconds = await readGraceSecondsLive({
    publicClient,
    diamondAddress: diamond,
    durationDays: Number(liveLoan.durationDays),
  });
  const chainNow = latestBlock.timestamp;
  const endTime = loanEndTimeOf(liveLoan, chainNow);
  if (chainNow > endTime + graceSeconds) {
    return refusal(loan.loanId, copy.errors.refinancePastGrace);
  }
  // The review quoted a fee config — a governance retune inside its
  // window must force a re-review, not a silent drift between the quoted
  // fees and the enforced ones.
  if (
    liveFees.treasuryFeeBps !== reviewedFees.treasuryFeeBps ||
    liveFees.loanInitiationFeeBps !== reviewedFees.loanInitiationFeeBps ||
    liveFees.maxOfferDurationDays !== reviewedFees.maxOfferDurationDays
  ) {
    return refusal(loan.loanId, copy.match.termsChanged, true);
  }
  // Guardrails: rate ceiling = the reviewed rate; end-date window =
  // accept-time + duration must fit inside it. Written only when the
  // existing caps don't already cover the reviewed terms — the OFFER's
  // own rate ceiling and expiry are what bind the accept, so looser
  // pre-existing caps are harmless.
  const neededExpiry =
    chainNow + (BigInt(terms.durationDays) + REQUEST_WINDOW_DAYS) * 86_400n;
  const capsCover =
    caps.enabled && Number(caps.maxRateBps) >= terms.rateBps && caps.maxNewExpiry >= neededExpiry;
  // The approval is sized to the wallet's share of the payoff at the
  // request's LAST fillable moment (its own expiry or the grace end,
  // whichever first): since #1189 the pull GROWS past maturity by the
  // grace-window late fee. The share is the payoff less the new loan's
  // net principal at the live fee rate (#3042); the request asks for the
  // old principal (`toRefinanceOfferPayload`).
  const requestExpiry = chainNow + REQUEST_WINDOW_DAYS * 86_400n;
  const payoff = refinancePayoffOf(liveLoan, chainNow);
  const request = {
    requestAmount: liveLoan.principal,
    loanInitiationFeeBps: liveFees.loanInitiationFeeBps,
  };
  const topUp = refinanceWalletPullOf(liveLoan, request, chainNow);
  const approval = refinanceApprovalOf(liveLoan, {
    expiresAt: requestExpiry,
    graceSeconds,
    ...request,
  });
  // OfferCreateFacet clamps a refinance request's expiry to the grace
  // boundary (graceEnd + 1); when that binds, the request lives until
  // the grace end, not for the full window.
  const graceEnd = endTime + graceSeconds;
  return {
    kind: 'ready',
    loanId: loan.loanId,
    liveLoan,
    chainNow,
    payoff,
    topUp,
    approval,
    headroom: approval > topUp ? approval - topUp : 0n,
    requestExpiry,
    graceEnd,
    expiryGraceClamped: graceEnd + 1n < requestExpiry,
    pastDue: chainNow > endTime,
    caps: capsCover ? null : { rateBps: terms.rateBps, maxNewExpiry: neededExpiry },
    payload: toRefinanceOfferPayload(liveLoan, loan.loanId, {
      rateBpsMax: terms.rateBps,
      durationDays: terms.durationDays,
      consent: true,
      // The request's own hard expiry — what makes the reviewed lifetime
      // true even when looser caps pre-exist, and the bound the approval
      // was computed against.
      expiresAt: requestExpiry,
    }),
  };
}

/** The Diamond calls a ready request makes, in order: the guardrail
 *  write when needed, then the request. The request's own validation
 *  refuses caps that do not cover it, so it can never post without the
 *  guardrails it needs. */
export function refinanceCalls(
  plan: RefinanceRequestReady,
): { functionName: string; args: readonly unknown[] }[] {
  const calls: { functionName: string; args: readonly unknown[] }[] = [];
  if (plan.caps) {
    calls.push({
      functionName: 'setAutoRefinanceCaps',
      args: [BigInt(plan.loanId), true, plan.caps.rateBps, plan.caps.maxNewExpiry],
    });
  }
  calls.push({ functionName: 'createOffer', args: [plan.payload] });
  return calls;
}

/**
 * A request the protocol would refuse because the loan already has one
 * on record — open, or expired and never cancelled (#2424 r7) — found
 * live, or a search that could not answer. ONE rule for the loan page's
 * form and the batch; `openMsg` lets the batch point at the loan's own
 * page instead of the form's wording.
 */
export async function refinancePostRefusal(
  ctx: RefinanceCtx,
  loan: CloseOutLoan,
  openMsg: string = copy.refinance.alreadyOpen,
): Promise<string | null> {
  const verdict = postRefinanceVerdict(
    await discoverRefinanceRequest({
      client: ctx.publicClient,
      diamond: ctx.diamond,
      loanId: BigInt(loan.loanId),
      sinceOfferId: BigInt(loan.offerId),
      holder: ctx.holder,
    }),
  );
  if (verdict === 'open') return openMsg;
  if (verdict === 'expired') return copy.refinance.expiredBlocksNew;
  if (verdict === 'capped') return copy.refinance.cappedBlocks;
  if (verdict === 'unchecked') return copy.refinance.uncheckedBlocks;
  return null;
}

/**
 * The statements a refinance request makes that depend on the loan. ONE
 * source for the loan page's form and the batch review, so a statement
 * the form makes cannot go missing from the batch.
 */
export interface RefinanceStatements {
  /** Past the due date: the payoff carries the growing late fee. */
  pastDue: string | null;
  /** Periodic interest on THIS loan: while the request is open, an
   *  overdue period makes a lender's acceptance fail until it is settled. */
  keepPeriodsCurrent: string | null;
  /** Periodic interest: scheduled interest ends with this loan, and the
   *  replacement runs on its own terms. */
  cadenceChange: string | null;
  /** When the request ends. */
  whenEnds: string;
}

export function refinanceStatements(loan: {
  pastDue: boolean;
  periodic: boolean;
  expiryGraceClamped: boolean;
  graceEnd: bigint;
}): RefinanceStatements {
  return {
    pastDue: loan.pastDue ? copy.refinance.graceNote : null,
    keepPeriodsCurrent: loan.periodic ? copy.refinance.periodicWarning : null,
    cadenceChange: loan.periodic ? copy.refinance.cadenceChangeNote : null,
    whenEnds: copy.refinance.whenEndsComposed(
      loan.expiryGraceClamped
        ? copy.refinance.expiresAtGraceEnd(formatDate(Number(loan.graceEnd)))
        : copy.refinance.expiresAfterDays(Number(REQUEST_WINDOW_DAYS)),
    ),
  };
}

/** Every statement for one loan, in the order the loan page makes them,
 *  as one list for the batch review. */
export function refinanceNotes(plan: RefinanceRequestReady): string[] {
  const s = refinanceStatements({
    pastDue: plan.pastDue,
    periodic: plan.liveLoan.periodicInterestCadence !== 0,
    expiryGraceClamped: plan.expiryGraceClamped,
    graceEnd: plan.graceEnd,
  });
  return [s.pastDue, s.keepPeriodsCurrent, s.cadenceChange, s.whenEnds].filter(
    (n): n is string => n !== null,
  );
}

export type RefinanceBatchPlan = (RefinanceRequestReady & { notes: string[] }) | RefinanceRefusal;

/**
 * The plan for one loan in a batch. A batch carries only loans with
 * NOTHING else to disclose: where the loan page holds its refinance form
 * (a rental, an accepted sale waiting to complete, a request already on
 * record, an open offset), the batch leaves the loan out and says why.
 * Every read failure is that loan's refusal, never the batch's.
 *
 * With a `reviewed` plan it is the late re-check before a send: a loan
 * whose approval bound or spare amount grew past the one reviewed, or
 * whose statements changed (it went past due, its request would now end
 * at the grace end), is left out rather than posted on terms the
 * borrower did not see. The reviewed figures are what the balance check
 * and the approval were sized on, so a loan is sent only while its
 * figures are at most those: in grace the spare amount grows with each
 * day's late fee while the bound stays fixed at the grace end, and a
 * request sent on a grown spare amount could be posted already unfunded.
 * A figure that shrank is fine: the pull only gets smaller.
 */
export async function planRefinanceForBatch(
  ctx: RefinanceCtx,
  loan: RefinanceLoan,
  terms: RefinanceTerms,
  reviewedFees: ReviewedFees,
  reviewed?: Extract<RefinanceBatchPlan, { kind: 'ready' }>,
): Promise<RefinanceBatchPlan> {
  try {
    if (loan.assetType !== AssetType.ERC20) {
      return refusal(loan.loanId, copy.batchRefinance.ownPageRental);
    }
    const blocked =
      (await saleSettlementRefusal(ctx.publicClient, ctx.diamond, loan, ctx.holder)) ??
      (await refinancePostRefusal(ctx, loan, copy.batchRefinance.ownPageOpenRequest)) ??
      (await offsetLockRefusal(ctx, loan));
    if (blocked) return refusal(loan.loanId, blocked);
    const plan = await checkRefinanceRequest(ctx, loan, terms, reviewedFees);
    if (plan.kind === 'refused') return plan;
    const notes = refinanceNotes(plan);
    if (
      reviewed &&
      (notes.join('\n') !== reviewed.notes.join('\n') ||
        plan.approval > reviewed.approval ||
        plan.topUp > reviewed.topUp)
    ) {
      return refusal(loan.loanId, copy.batchRefinance.changedSinceReview);
    }
    return { ...plan, notes };
  } catch (err) {
    return refusal(loan.loanId, captureTxError(err));
  }
}
