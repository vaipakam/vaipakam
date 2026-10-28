/**
 * The per-loan close-out plan (#126) — ONE copy of the live checks a
 * borrower's full repayment and early close run before anything is
 * signed, shared by the loan page and the batch on Positions.
 *
 * Before this module the checks lived inline in PositionDetails' two
 * handlers. A batch that restated them would be a second copy of the
 * rule, and the copies would drift: the page has collected one review
 * round per missing re-check (sale acceptance, refinance request, offset
 * lock, grace on the LIVE term, position NFT still held). So the batch
 * plans each loan through exactly the functions the page now calls.
 *
 * What a plan is: either the Diamond call to make and the token pull it
 * needs (what the contract will take now, and the padded figure to
 * approve and balance-check), or the reason the loan cannot take the
 * action now. Read failures THROW, exactly as the page's inline reads
 * did; a caller that plans many loans turns a throw into that loan's
 * refusal (`planCloseOutForBatch`).
 *
 * What a plan is NOT: a balance check or an approval. A batch checks the
 * wallet against the SUM of its loans' pulls and approves that sum once,
 * so both stay with the caller.
 */
import type { PublicClient } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { copy } from '../content/copy';
import { captureTxError } from '../lib/errors';
import { AssetType, LoanStatus } from '../lib/types';
import {
  LOAN_STATUS_ACTIVE,
  loanEndTimeOf,
  readLoanLive,
  readRepaymentDueLive,
} from '../contracts/loanLive';
import {
  assertPositionNftHeldLive,
  readGraceSecondsLive,
} from '../contracts/preflights';
import { assertWalletNotSanctionedLive } from './sanctions';
import { probeSaleHoldLive } from './saleListingHold';
import { discoverRefinanceRequest } from './refinanceDiscovery';
import { liveRefinanceVerdict } from './refinanceInterlock';
import { LOCK_PRECLOSE_OFFSET } from './offsetPending';

export type CloseOutAction = 'repay' | 'preclose';

/** The loan fields a plan reads — a subset of the indexer row, so both
 *  the page's reconciled row and a Positions list row satisfy it. */
export interface CloseOutLoan {
  loanId: number;
  offerId: number;
  borrowerTokenId: string;
  lenderTokenId: string;
  assetType: number;
  collateralAssetType: number;
  lendingAsset: string;
}

export interface CloseOutCtx {
  publicClient: PublicClient;
  diamond: `0x${string}`;
  /** The connected wallet — the borrower position's expected holder. */
  holder: `0x${string}`;
}

/** What the call will take from the wallet. `due` is the contract's own
 *  figure now; `approve` adds the day-boundary pad, which is what the
 *  wallet must hold and the allowance must cover. The call pulls only
 *  what it recomputes, so the pad is never spent. */
export interface CloseOutPull {
  token: `0x${string}`;
  due: bigint;
  approve: bigint;
}

export type CloseOutPlan =
  | {
      kind: 'ready';
      loanId: number;
      action: CloseOutAction;
      functionName: 'repayLoan' | 'precloseDirect';
      /** Null for a rental close, which pulls nothing the app approves. */
      pull: CloseOutPull | null;
      /** The live status the plan was judged on. */
      liveStatus: number;
    }
  | { kind: 'refused'; loanId: number; action: CloseOutAction; reason: string };

const refused = (
  loan: CloseOutLoan,
  action: CloseOutAction,
  reason: string,
): CloseOutPlan => ({ kind: 'refused', loanId: loan.loanId, action, reason });

/** Mirrors `createLoanSaleOffer`'s shape check (ERC-20 principal AND
 *  ERC-20 collateral): a loan outside it can never carry a listing, so
 *  it pays no sale probe and never fails closed on one (Codex #1511 r7). */
export function saleEligible(loan: CloseOutLoan): boolean {
  return (
    loan.assetType === AssetType.ERC20 && loan.collateralAssetType === AssetType.ERC20
  );
}

/**
 * The accepted-sale completion window, read live (Codex #1511 r4/r5): a
 * close-out while a buyer's acceptance waits to complete terminalizes the
 * loan and strands the buyer's recovery. Blocks only while the loan is
 * genuinely Active — on anything else there is no completion left to
 * strand. Fails closed: an unanswered probe is a refusal.
 */
export async function saleSettlementRefusal(
  publicClient: PublicClient,
  diamond: `0x${string}`,
  loan: CloseOutLoan,
  viewer: `0x${string}` | undefined,
  /** Judge the sale at this block rather than the latest. */
  atBlock?: bigint,
): Promise<string | null> {
  if (!saleEligible(loan)) return null;
  try {
    const state = await probeSaleHoldLive(
      publicClient,
      diamond,
      loan.loanId,
      loan.lenderTokenId,
      viewer,
      atBlock,
    );
    if (state === 'accepted') {
      const live = await readLoanLive(publicClient, diamond, loan.loanId, atBlock);
      return Number(live.status) === LOAN_STATUS_ACTIVE
        ? copy.saleHold.completionPaused
        : null;
    }
    // An unrecognized decoded revert is as unanswered as an RPC failure
    // (Codex #1511 r8).
    if (state === 'unknown') return copy.saleHold.checkFailed;
    return null;
  } catch {
    return copy.saleHold.checkFailed;
  }
}

/**
 * A refinance request posted since the last poll, found live (#2391 /
 * #2406): settling or changing the loan would leave it impossible to
 * fill. A search that cannot answer refuses too.
 */
export async function refinanceRefusal(
  ctx: CloseOutCtx,
  loan: CloseOutLoan,
  /** What to say when an open request is found. */
  blockedMsg: string = copy.refinance.liveBlocksSettlement,
): Promise<string | null> {
  if (loan.assetType !== AssetType.ERC20) return null;
  const verdict = liveRefinanceVerdict(
    await discoverRefinanceRequest({
      client: ctx.publicClient,
      diamond: ctx.diamond,
      loanId: BigInt(loan.loanId),
      sinceOfferId: BigInt(loan.offerId),
      holder: ctx.holder,
    }),
  );
  if (verdict === 'open') return blockedMsg;
  if (verdict === 'capped') return copy.refinance.cappedBlocks;
  if (verdict === 'unchecked') return copy.refinance.uncheckedBlocks;
  return null;
}

/**
 * The borrower position's offset lock, read live (Codex #1500 r4): while
 * an offset offer is open, settling another way strands it. Fails CLOSED:
 * an unreadable lock throws.
 */
export async function offsetLockRefusal(
  ctx: CloseOutCtx,
  loan: CloseOutLoan,
): Promise<string | null> {
  if (loan.assetType !== AssetType.ERC20) return null;
  const lock = Number(
    await ctx.publicClient.readContract({
      address: ctx.diamond,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'positionLock',
      args: [BigInt(loan.borrowerTokenId)],
    }),
  );
  return lock === LOCK_PRECLOSE_OFFSET ? copy.offset.blockedOtherPaths : null;
}

/** ~2 days of interest plus the worst single late-fee jump: the 1% base
 *  landing when a close signed just before maturity mines just after it,
 *  plus a 0.5% day-step (Codex #1256 r1). One pad for both actions, on
 *  the LIVE principal and rate. */
function dayBoundaryPad(principal: bigint, rateBps: bigint): bigint {
  return (principal * rateBps * 2n) / (365n * 10_000n) + (principal * 150n) / 10_000n;
}

/**
 * Full repayment (`repayLoan`). Checks, in the order the page ran them:
 * the live status (Active, or FallbackPending — the cure path), the
 * position NFT still held, and for an ERC-20 loan the grace window by
 * CHAIN time on the LIVE term. Then the pull: the contract's own figure,
 * or on FallbackPending (where that figure reads 0 while `repayLoan`
 * still pulls principal and interest) an estimate from the live loan.
 */
export async function planRepay(
  ctx: CloseOutCtx,
  loan: CloseOutLoan,
): Promise<CloseOutPlan> {
  const { publicClient, diamond, holder } = ctx;
  const erc20 = loan.assetType === AssetType.ERC20;
  const [calcDue, latestBlock, live] = await Promise.all([
    readRepaymentDueLive(publicClient, diamond, loan.loanId),
    publicClient.getBlock({ blockTag: 'latest' }),
    // The LIVE loan, unconditionally (OBS-2 #988): its status gates
    // rentals too, and a keeper's extend moves the term under the row.
    readLoanLive(publicClient, diamond, loan.loanId),
  ]);
  const chainNow = latestBlock.timestamp;
  if (live.status !== LoanStatus.Active && live.status !== LoanStatus.FallbackPending) {
    return refused(loan, 'repay', copy.errors.loanAlreadySettled);
  }
  // repayLoan is permissionless — the role came from a cached ownerOf.
  const [, graceSec] = await Promise.all([
    assertPositionNftHeldLive({
      publicClient,
      diamondAddress: diamond,
      tokenId: loan.borrowerTokenId,
      expectedOwner: holder,
    }),
    erc20
      ? readGraceSecondsLive({
          publicClient,
          diamondAddress: diamond,
          durationDays: Number(live.durationDays),
        })
      : Promise.resolve(0n),
  ]);
  if (erc20 && chainNow > loanEndTimeOf(live, chainNow) + graceSec) {
    return refused(loan, 'repay', copy.errors.pastGrace);
  }
  let due = calcDue;
  if (due === 0n && live.status === LoanStatus.FallbackPending) {
    const elapsedDays =
      chainNow > live.startTime ? (chainNow - live.startTime) / 86_400n : 0n;
    const interestEst =
      (live.principal * live.interestRateBps * (elapsedDays + 2n)) / (365n * 10_000n);
    // Late fees mirror LibVaipakam.calculateLateFee: 1% base + 0.5%/day
    // past maturity, CAPPED at 5%, judged on the live term, one day-step
    // ahead.
    const endTimeLive = loanEndTimeOf(live, chainNow);
    const daysPastEnd = chainNow > endTimeLive ? (chainNow - endTimeLive) / 86_400n : 0n;
    let lateFeeBps = 100n + (daysPastEnd + 2n) * 50n;
    if (lateFeeBps > 500n) lateFeeBps = 500n;
    due = live.principal + interestEst + (live.principal * lateFeeBps) / 10_000n;
  }
  const pull =
    erc20 && due > 0n
      ? {
          token: loan.lendingAsset as `0x${string}`,
          due,
          approve: due + dayBoundaryPad(live.principal, live.interestRateBps),
        }
      : null;
  return {
    kind: 'ready',
    loanId: loan.loanId,
    action: 'repay',
    functionName: 'repayLoan',
    pull,
    liveStatus: live.status,
  };
}

/**
 * Early close (`precloseDirect`), ERC-20 loans only. A Tier-1 entry point,
 * so the wallet is re-screened live first. Then the position NFT, the
 * grace window (precloseDirect stays valid THROUGH it since #1189 and
 * reverts strictly past it), the live status, and the live offset lock.
 */
export async function planPreclose(
  ctx: CloseOutCtx,
  loan: CloseOutLoan,
): Promise<CloseOutPlan> {
  const { publicClient, diamond, holder } = ctx;
  await assertWalletNotSanctionedLive(publicClient, diamond, holder);
  const [, live, calcDue, latestBlock] = await Promise.all([
    assertPositionNftHeldLive({
      publicClient,
      diamondAddress: diamond,
      tokenId: loan.borrowerTokenId,
      expectedOwner: holder,
    }),
    readLoanLive(publicClient, diamond, loan.loanId),
    readRepaymentDueLive(publicClient, diamond, loan.loanId),
    publicClient.getBlock({ blockTag: 'latest' }),
  ]);
  const graceSec = await readGraceSecondsLive({
    publicClient,
    diamondAddress: diamond,
    durationDays: Number(live.durationDays),
  });
  if (latestBlock.timestamp > loanEndTimeOf(live, latestBlock.timestamp) + graceSec) {
    return refused(loan, 'preclose', copy.errors.preclosePastGrace);
  }
  // calculateRepaymentAmount IS the preclose figure, and reads 0 for any
  // non-Active loan — but 0 on a still-Active loan is the legal "principal
  // fully paid down via partials" state, which precloseDirect settles.
  if (calcDue === 0n && live.status !== LOAN_STATUS_ACTIVE) {
    return refused(loan, 'preclose', copy.errors.loanAlreadySettled);
  }
  // Read live: the page's own offset card is a cached read, and a batch
  // has no card at all.
  const offset = await offsetLockRefusal(ctx, loan);
  if (offset) return refused(loan, 'preclose', offset);
  return {
    kind: 'ready',
    loanId: loan.loanId,
    action: 'preclose',
    functionName: 'precloseDirect',
    pull: {
      token: loan.lendingAsset as `0x${string}`,
      due: calcDue,
      approve: calcDue + dayBoundaryPad(live.principal, live.interestRateBps),
    },
    liveStatus: live.status,
  };
}

/**
 * The plan for one loan in a batch. A batch carries only loans with
 * NOTHING to disclose: where the loan page would stop to show the
 * borrower something before they confirm (a refinance request, an open
 * offset, a loan in its fallback cure, a rental), the batch leaves the
 * loan out and says to close it from its own page. Every read failure is
 * that loan's refusal, never the batch's.
 */
export async function planCloseOutForBatch(
  ctx: CloseOutCtx,
  loan: CloseOutLoan,
  action: CloseOutAction,
): Promise<CloseOutPlan> {
  try {
    if (loan.assetType !== AssetType.ERC20) {
      return refused(loan, action, copy.batchClose.ownPageRental);
    }
    const blocked =
      (await saleSettlementRefusal(ctx.publicClient, ctx.diamond, loan, ctx.holder)) ??
      (await refinanceRefusal(ctx, loan, copy.batchClose.ownPageRefinance)) ??
      (await offsetLockRefusal(ctx, loan));
    if (blocked) return refused(loan, action, blocked);
    const plan = action === 'repay' ? await planRepay(ctx, loan) : await planPreclose(ctx, loan);
    if (plan.kind === 'ready' && plan.liveStatus !== LOAN_STATUS_ACTIVE) {
      return refused(loan, action, copy.batchClose.ownPageFallback);
    }
    return plan;
  } catch (err) {
    return refused(loan, action, captureTxError(err));
  }
}

/**
 * The late re-check, run after the approval and immediately before the
 * send: an acceptance, request or offset can land while the wallet waits
 * on the approval. Null when the loan may still go in the batch.
 */
export async function lateBatchRefusal(
  ctx: CloseOutCtx,
  loan: CloseOutLoan,
): Promise<string | null> {
  try {
    return (
      (await saleSettlementRefusal(ctx.publicClient, ctx.diamond, loan, ctx.holder)) ??
      (await refinanceRefusal(ctx, loan, copy.batchClose.ownPageRefinance)) ??
      (await offsetLockRefusal(ctx, loan))
    );
  } catch (err) {
    return captureTxError(err);
  }
}
