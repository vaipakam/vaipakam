/**
 * The per-loan sale-listing plan (#126 slice 2) — ONE copy of the live
 * checks a lender's listing (`createLoanSaleOfferBound`, #1810) runs before
 * anything is signed, shared by the loan page's listing form and the
 * "List all for sale" batch on Positions.
 *
 * Before this module the checks lived inline in `LoanSaleFlow.submit`. A
 * batch that restated them would be a second copy of the rule, and the
 * copies would drift — the same reason the close-out checks moved into
 * `closeOutPlan.ts` in slice 1.
 *
 * The listing needs no token approval and draws nothing from the seller's
 * wallet (net settlement, #2674), so a plan carries no pull. What it does
 * carry is the pair of figures the listing is BOUND to: the minimum the
 * seller is guaranteed and the ceiling on what is already set aside for
 * the lender, quoted from the chain (`sellerBoundsQuote.ts`) and frozen at
 * the review. The chain refuses a listing that would record worse ones.
 *
 * Read failures THROW, as the inline checks did; a caller that plans many
 * loans turns a throw into that loan's refusal (`planSaleListingForBatch`).
 */
import type { PublicClient } from 'viem';
import { BaseError, ContractFunctionRevertedError } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { copy } from '../content/copy';
import { captureTxError } from '../lib/errors';
import { formatDateTime } from '../lib/format';
import { AssetType } from '../lib/types';
import { TxNotSettledError } from '../contracts/ownReceipt';
import {
  LOAN_STATUS_ACTIVE,
  MIN_SALE_LISTING_SECONDS,
  loanEndTimeOf,
  readLoanLive,
} from '../contracts/loanLive';
import {
  assertAssetNotPausedLive,
  assertPositionNftHeldLive,
} from '../contracts/preflights';
import { assertWalletNotSanctionedLive } from './sanctions';
import { saleSettlementNow } from './loanSalePending';
import { readSellerBoundsQuote } from './sellerBoundsQuote';
import { FEE_MODE_FULL, readFeeEntitlement } from './tariff';

/** The loan fields a listing plan reads — a subset of the indexer row, so
 *  both the page's reconciled row and a Positions list row satisfy it. */
export interface SaleListingLoan {
  loanId: number;
  lenderTokenId: string;
  assetType: number;
  collateralAssetType: number;
  lendingAsset: string;
  collateralAsset: string;
}

export interface SaleListingCtx {
  publicClient: PublicClient;
  diamond: `0x${string}`;
  /** The connected wallet — the lender position's expected holder. */
  holder: `0x${string}`;
}

/** What the seller chose: the same for every loan in a batch. */
export interface SaleListingTerms {
  /** The yearly rate a buyer earns, in basis points. */
  rateBps: number;
  /** The listing window; the chain clamps it at the loan's due date. */
  listingSeconds: bigint;
}

/** The two figures a listing is bound to (#1810). */
export interface ListingBounds {
  minSellerNet: bigint;
  maxHeld: bigint;
}

/** Why a listing would be refused now. `boundsMoved` marks the refusals
 *  that say the reviewed figures no longer hold, so a caller can drop its
 *  review rather than offer the same figures again. */
export interface ListingRefusal {
  reason: string;
  boundsMoved: boolean;
}

/** The exact call a listing makes, with consent given. */
export function boundListingArgs(
  loanId: number,
  terms: SaleListingTerms,
  bounds: ListingBounds,
): readonly [bigint, number, boolean, bigint, bigint, bigint] {
  return [
    BigInt(loanId),
    terms.rateBps,
    true,
    terms.listingSeconds,
    bounds.minSellerNet,
    bounds.maxHeld,
  ];
}

/** The failures that say the figures a seller reviewed no longer hold: the
 *  listing would record a lower minimum, or more already set aside for the
 *  lender, than they agreed to — or it mined reverted, so which of its
 *  checks moved is unknown. */
export function reviewedBoundsMoved(err: unknown): boolean {
  // A listing that MINED reverted carries no decoded revert data (the write
  // reports it as `TxNotSettledError`), so its reason cannot be read here.
  // Whatever it was, the chain moved between the review and the block, so the
  // reviewed figures are no longer known to hold: treat it the same way.
  if (err instanceof TxNotSettledError) return err.reason === 'reverted';
  const name = revertOf(err)?.data?.errorName;
  return name === 'ListingFloorBelowReviewed' || name === 'ListingHeldAboveReviewed';
}

function revertOf(err: unknown): ContractFunctionRevertedError | null {
  if (!(err instanceof BaseError)) return null;
  return err.walk(
    (e) => e instanceof ContractFunctionRevertedError,
  ) as ContractFunctionRevertedError | null;
}

/** A simulated listing's refusal, worded. The relist cooldown carries when
 *  relisting opens (the contract surfaces it in the error for this). */
export function listingRefusalText(err: unknown): string {
  const revert = revertOf(err);
  if (
    revert?.data?.errorName === 'SaleRelistCooldownActive' &&
    typeof revert.data.args?.[0] === 'bigint'
  ) {
    return copy.errors.saleRelistCooldownActive(formatDateTime(Number(revert.data.args[0])));
  }
  return captureTxError(err);
}

/**
 * The checks a listing runs immediately before it is signed, bound to the
 * figures the seller reviewed. Returns null when the listing would be
 * made, or the refusal. A refusal the preflights raise (sanctions, the
 * position NFT not held, a paused asset) and every failed read THROW.
 */
export async function checkSaleListing(
  ctx: SaleListingCtx,
  loan: SaleListingLoan,
  terms: SaleListingTerms,
  bounds: ListingBounds,
): Promise<ListingRefusal | null> {
  const { publicClient, diamond, holder } = ctx;
  // Tier-1 — the listing routes the buyer's principal to the seller;
  // re-screen live.
  await assertWalletNotSanctionedLive(publicClient, diamond, holder);
  const [, liveLoan, latestBlock] = await Promise.all([
    assertPositionNftHeldLive({
      publicClient,
      diamondAddress: diamond,
      tokenId: loan.lenderTokenId,
      expectedOwner: holder,
    }),
    readLoanLive(publicClient, diamond, loan.loanId),
    publicClient.getBlock({ blockTag: 'latest' }),
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
    return { reason: copy.errors.loanAlreadySettled, boundsMoved: false };
  }
  // The listing reverts at or past maturity, and ALSO when less than the
  // minimum listing window remains before it — `_boundListingExpiry` clamps
  // every window at maturity and refuses a clamped window below the
  // minimum (Codex #1505 r2). The EFFECTIVE maturity (#668 / #935): what
  // the chain clamps at, moved by the paused time since the loan's start.
  const maturityTs = loanEndTimeOf(liveLoan, latestBlock.timestamp);
  if (latestBlock.timestamp >= maturityTs) {
    return { reason: copy.errors.saleListingMatured, boundsMoved: false };
  }
  if (maturityTs - latestBlock.timestamp < MIN_SALE_LISTING_SECONDS) {
    return { reason: copy.errors.saleListingTooCloseToMaturity, boundsMoved: false };
  }
  // Codex #1505 r5 — simulate the EXACT bound listing before anything is
  // signed. It catches every refusal the checks above can't see (the
  // relist cooldown, a live offset, a position that can't be consolidated)
  // and, with the reviewed figures, a minimum that has already moved.
  try {
    await publicClient.simulateContract({
      address: diamond,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'createLoanSaleOfferBound',
      args: boundListingArgs(loan.loanId, terms, bounds),
      account: holder,
    });
  } catch (simErr) {
    return { reason: listingRefusalText(simErr), boundsMoved: reviewedBoundsMoved(simErr) };
  }
  return null;
}

export type SaleListingPlan =
  | {
      kind: 'ready';
      loanId: number;
      /** The figures this listing is bound to, frozen at the review. */
      bounds: ListingBounds;
      /** The settlement a buyer's acceptance would deduct right now. */
      settlementNow: bigint;
      /** What the loan page states before a listing is signed, for a
       *  surface that shows no loan page (the batch). */
      notes: string[];
    }
  | { kind: 'refused'; loanId: number; reason: string; boundsMoved: boolean };

/**
 * The plan for one loan in a batch listing. Every read failure is that
 * loan's refusal, never the batch's.
 *
 * With no `reviewed` plan it QUOTES: the figures come from the chain for
 * these terms, and the plan is what the review shows. With one, it is the
 * late re-check before a send: the figures stay the ones the seller
 * reviewed (the listing is bound to them, and the chain refuses it if they
 * no longer hold), and a loan whose statements changed since the review —
 * its fee mode now travels with the position, or no longer does — is left
 * out rather than listed under a disclosure the seller did not see.
 */
export async function planSaleListingForBatch(
  ctx: SaleListingCtx,
  loan: SaleListingLoan,
  terms: SaleListingTerms,
  reviewed?: Extract<SaleListingPlan, { kind: 'ready' }>,
): Promise<SaleListingPlan> {
  const refused = (reason: string, boundsMoved = false): SaleListingPlan => ({
    kind: 'refused',
    loanId: loan.loanId,
    reason,
    boundsMoved,
  });
  try {
    // The listing escrows no collateral and sells no rental (#951, #974);
    // the chain refuses either shape, so neither pays for the reads below.
    if (
      loan.assetType !== AssetType.ERC20 ||
      loan.collateralAssetType !== AssetType.ERC20
    ) {
      return refused(copy.batchSale.ownPageShape);
    }
    const [live, fe] = await Promise.all([
      readLoanLive(ctx.publicClient, ctx.diamond, loan.loanId),
      // The loan page holds its sale tools until the fee record is read
      // (the Full mode travels with the position), so an unreadable
      // record throws here and leaves the loan out.
      readFeeEntitlement(ctx.publicClient, ctx.diamond, loan.loanId),
    ]);
    // Today's settlement needs the forfeit term; the page shows the
    // listing as unavailable without it rather than substitute a figure.
    if (live.lenderForfeitFrom === undefined) return refused(copy.loanSale.floorUnavailable);
    const settlementNow = saleSettlementNow(live, BigInt(terms.rateBps));
    const notes = saleListingNotes({
      fullModeTravels: fe.lenderMode === FEE_MODE_FULL,
      aboveLoanRate: BigInt(terms.rateBps) > live.interestRateBps,
    });
    if (reviewed && notes.join('\n') !== reviewed.notes.join('\n')) {
      return refused(copy.batchSale.changedSinceReview);
    }
    const bounds =
      reviewed?.bounds ??
      (await readSellerBoundsQuote(ctx.publicClient, ctx.diamond, {
        loanId: loan.loanId,
        saleRateBps: BigInt(terms.rateBps),
        listingSeconds: terms.listingSeconds,
        maturity: loanEndTimeOf(live),
      }));
    const refusal = await checkSaleListing(ctx, loan, terms, bounds);
    if (refusal) return refused(refusal.reason, refusal.boundsMoved);
    return {
      kind: 'ready',
      loanId: loan.loanId,
      bounds: { minSellerNet: bounds.minSellerNet, maxHeld: bounds.maxHeld },
      settlementNow,
      notes,
    };
  } catch (err) {
    return refused(captureTxError(err), reviewedBoundsMoved(err));
  }
}

/**
 * The statements the loan page makes around a listing that are specific
 * to the loan, as one list per loan for the batch review: the Full fee
 * mode travelling to the buyer with the position, and a rate above the
 * loan's own costing the seller the difference.
 */
export function saleListingNotes(facts: {
  fullModeTravels: boolean;
  aboveLoanRate: boolean;
}): string[] {
  const notes: string[] = [];
  if (facts.fullModeTravels) notes.push(copy.tariff.nftTravelNote);
  if (facts.aboveLoanRate) notes.push(copy.loanSale.sweetenNote);
  return notes;
}
