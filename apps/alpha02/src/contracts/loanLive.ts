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
