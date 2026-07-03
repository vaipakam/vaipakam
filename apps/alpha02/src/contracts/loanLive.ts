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
  principal: bigint;
  interestRateBps: bigint;
  startTime: bigint;
  /** Term fields come from HERE for any time gate — a term-resetting
   *  position transfer re-stamps them on-chain while the indexer row
   *  still carries the old values. */
  durationDays: bigint;
  interestAccrualStart: bigint;
  useFullTermInterest: boolean;
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
    principal: raw.principal,
    interestRateBps: raw.interestRateBps,
    startTime: raw.startTime,
    durationDays: raw.durationDays,
    interestAccrualStart: raw.interestAccrualStart,
    useFullTermInterest: Boolean(raw.useFullTermInterest),
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
