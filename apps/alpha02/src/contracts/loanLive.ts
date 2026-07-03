/**
 * Live loan reads for submit paths and money-critical display — ONE
 * definition of the getLoanDetails shape the UI consumes, so the
 * Solidity struct evolving can't silently strand a stale hand-written
 * cast in one of several files (the casts are unchecked `as`).
 */
import type { PublicClient } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';

/** LibVaipakam.LoanStatus.Active — first enum member. */
export const LOAN_STATUS_ACTIVE = 0;

/** The subset of LibVaipakam.Loan the UI reads live. */
export interface LoanLive {
  /** LibVaipakam.LoanStatus as a number (Active = 0). */
  status: number;
  /** The ORIGINAL borrower stored at init — NOT the current
   *  borrower-NFT holder. Carry-over refinance binds to this. */
  borrower: `0x${string}`;
  principal: bigint;
  principalAsset: `0x${string}`;
  interestRateBps: bigint;
  startTime: bigint;
  /** Term fields come from HERE for any time gate — a term-resetting
   *  position transfer re-stamps them on-chain while the indexer row
   *  still carries the old values. */
  durationDays: bigint;
  interestAccrualStart: bigint;
  /** Remaining committed interest term, re-stamped by partials. Read
   *  via {@link interestRemainingDaysOf}, never directly — the raw
   *  field is only meaningful when `interestAccrualStart != 0`. */
  interestRemainingDays: number;
  useFullTermInterest: boolean;
  allowsPartialRepay: boolean;
  /** LibVaipakam.PeriodicInterestCadence as a number (None = 0). */
  periodicInterestCadence: number;
  // Collateral identity — a refinance-tagged offer must repeat these
  // EXACTLY for the collateral to carry over instead of re-pledging.
  collateralAsset: `0x${string}`;
  /** LibVaipakam.AssetType as a number (ERC20 = 0). */
  collateralAssetType: number;
  collateralAmount: bigint;
  collateralTokenId: bigint;
  collateralQuantity: bigint;
  prepayAsset: `0x${string}`;
}

/** Mirrors LibVaipakam.interestRemainingDaysOf: the dedicated
 *  remaining-term field (re-stamped by partials) when the #641
 *  interest clock is present, else the immutable term. */
export function interestRemainingDaysOf(live: LoanLive): bigint {
  return live.interestAccrualStart !== 0n
    ? BigInt(live.interestRemainingDays)
    : live.durationDays;
}

/** Mirrors LibVaipakam.interestAccrualStartOf: the #641 interest
 *  clock's origin (re-stamped by partials), falling back to the
 *  immutable start for pre-field loans. */
export function interestAccrualStartOf(live: LoanLive): bigint {
  return live.interestAccrualStart !== 0n
    ? live.interestAccrualStart
    : live.startTime;
}

/** The refinance old-lender payoff — principal + FULL-TERM interest
 *  on the remaining committed term (RefinanceFacet pays the exiting
 *  lender their maximum entitlement; no late fee, no shortfall). ONE
 *  definition — the review quote, the submit approval, the pending
 *  watch, and the restore action must never drift apart. */
export function refinancePayoffOf(live: LoanLive): bigint {
  const days = interestRemainingDaysOf(live);
  return (
    live.principal +
    (live.principal * live.interestRateBps * days) / (365n * 10_000n)
  );
}

/** Mirror LibVaipakam.SECONDS_PER_YEAR / BASIS_POINTS. */
export const SECONDS_PER_YEAR = 365n * 86_400n;
export const BASIS_POINTS = 10_000n;

/** Seller economics of selling a lender position into a buy offer —
 *  one definition for the picker rows, the review receipt, and the
 *  submit re-check. Mirrors EarlyWithdrawalFacet's net settlement TO
 *  THE WEI: seconds-precision, elapsed measured from the #641
 *  interest clock, remaining = remaining-term seconds minus elapsed
 *  (floored at 0), and the shortfall computed as the DIFFERENCE OF
 *  THE TWO FLOORED remaining-interest figures (not one floored
 *  difference). The seller forfeits the LARGER of accrued or
 *  shortfall, never both — `shortfallBinding` says which one is
 *  actually setting the cost. */
export function sellerEconomics(
  live: LoanLive,
  buyRateBps: bigint,
  chainNow: bigint,
): {
  cost: bigint;
  toSeller: bigint;
  shortfallBinding: boolean;
  /** Components exposed so the sale-listing funding math (which
   *  bounds them differently) reuses THESE definitions and can never
   *  drift from the facet by a rounding path. `accrued` uses RAW
   *  elapsed — the facet never clamps it to the interest window, so
   *  past window end it keeps growing. */
  accrued: bigint;
  shortfall: bigint;
} {
  const start = interestAccrualStartOf(live);
  const elapsed = chainNow > start ? chainNow - start : 0n;
  const totalSecs = interestRemainingDaysOf(live) * 86_400n;
  const remainingSecs = totalSecs > elapsed ? totalSecs - elapsed : 0n;
  const denom = SECONDS_PER_YEAR * BASIS_POINTS;
  const accrued = (live.principal * live.interestRateBps * elapsed) / denom;
  const originalRemaining =
    (live.principal * live.interestRateBps * remainingSecs) / denom;
  const newRemaining = (live.principal * buyRateBps * remainingSecs) / denom;
  const shortfall =
    newRemaining > originalRemaining ? newRemaining - originalRemaining : 0n;
  const cost = accrued > shortfall ? accrued : shortfall;
  return {
    cost,
    toSeller: live.principal > cost ? live.principal - cost : 0n,
    shortfallBinding: shortfall > accrued,
    accrued,
    shortfall,
  };
}

/** The sale path's duration-fit bound: the IMMUTABLE term minus
 *  whole days elapsed since the immutable start — NOT the interest
 *  clock (a partial re-stamps that; the borrower-favourability check
 *  does not care). */
export function durationFitDays(live: LoanLive, chainNow: bigint): bigint {
  const elapsedDays =
    chainNow > live.startTime ? (chainNow - live.startTime) / 86_400n : 0n;
  return live.durationDays > elapsedDays ? live.durationDays - elapsedDays : 0n;
}

export async function readLoanLive(
  publicClient: PublicClient,
  diamondAddress: `0x${string}`,
  loanId: number | bigint,
): Promise<LoanLive> {
  const raw = (await publicClient.readContract({
    address: diamondAddress,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getLoanDetails',
    args: [BigInt(loanId)],
  })) as LoanLive;
  return {
    status: Number(raw.status),
    borrower: raw.borrower,
    principal: raw.principal,
    principalAsset: raw.principalAsset,
    interestRateBps: raw.interestRateBps,
    startTime: raw.startTime,
    durationDays: raw.durationDays,
    interestAccrualStart: raw.interestAccrualStart,
    interestRemainingDays: Number(raw.interestRemainingDays),
    useFullTermInterest: Boolean(raw.useFullTermInterest),
    allowsPartialRepay: Boolean(raw.allowsPartialRepay),
    periodicInterestCadence: Number(raw.periodicInterestCadence),
    collateralAsset: raw.collateralAsset,
    collateralAssetType: Number(raw.collateralAssetType),
    collateralAmount: raw.collateralAmount,
    collateralTokenId: raw.collateralTokenId,
    collateralQuantity: raw.collateralQuantity,
    prepayAsset: raw.prepayAsset,
  };
}

/** The contract's own settlement figure (`calculateRepaymentAmount`)
 *  — routed through settlementInterestNet, so it already handles the
 *  full-term floor (max(elapsed, remaining)), interest already
 *  settled by partials/periodic, late fees, and CHAIN time. Both the
 *  repay and preclose paths pull per this math; quoting anything
 *  hand-derived risks drifting from what is actually charged. */
export async function readRepaymentDueLive(
  publicClient: PublicClient,
  diamondAddress: `0x${string}`,
  loanId: number | bigint,
): Promise<bigint> {
  return (await publicClient.readContract({
    address: diamondAddress,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'calculateRepaymentAmount',
    args: [BigInt(loanId)],
  })) as bigint;
}
