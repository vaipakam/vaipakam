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
  /** The stored lender. For a sale-listed loan, `createLoanSaleOffer`
   *  consolidated this to the current lender-NFT holder at listing
   *  (#951 D1/D2) — it is the seller a buy would pay. */
  lender: `0x${string}`;
  /** The ORIGINAL borrower stored at init — NOT the current
   *  borrower-NFT holder. Carry-over refinance binds to this. */
  borrower: `0x${string}`;
  /** The borrower-side position NFT — `ownerOf(borrowerTokenId)` is
   *  the CURRENT borrower every self-dealing guard keys on. */
  borrowerTokenId: bigint;
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

/** The loan's fixed origination maturity — the reference every
 *  late-fee and grace computation keys on (LibVaipakam.ONE_DAY days). */
export function loanEndTimeOf(live: LoanLive): bigint {
  return live.startTime + live.durationDays * 86_400n;
}

/** Mirrors LibVaipakam.calculateLateFee for ERC-20 loans: 0 at or
 *  before maturity, then 1% of principal + 0.5% per WHOLE day late,
 *  capped at 5%. Both the repay and the #1189 preclose/refinance
 *  grace-window paths charge exactly this. */
export function lateFeeAt(live: LoanLive, ts: bigint): bigint {
  const endTime = loanEndTimeOf(live);
  if (ts <= endTime) return 0n;
  const daysLate = (ts - endTime) / 86_400n;
  let feeBps = 100n + daysLate * 50n;
  if (feeBps > 500n) feeBps = 500n;
  return (live.principal * feeBps) / 10_000n;
}

/** The refinance old-lender payoff AS OF `asOf` (chain time). The
 *  facet pays `settlementInterestNet(oldLoan, now)` + the #1189
 *  grace-window late fee, and that settlement interest is
 *  `max(whole days elapsed since the interest clock, remaining
 *  committed term)` — i.e. the full-term floor in term, but PAST
 *  maturity it keeps accruing with elapsed time (Codex #1256 r1).
 *  This mirror applies the remaining-term floor in BOTH interest
 *  modes (exact for full-term loans; over-covers a pro-rata loan —
 *  the pull only shrinks) and stays gross of `interestSettled`
 *  (again over-covers only). ONE definition — the review quote, the
 *  pending watch, and the funding checks must never drift apart. */
export function refinancePayoffOf(live: LoanLive, asOf: bigint): bigint {
  const start = interestAccrualStartOf(live);
  const elapsedDays = asOf > start ? (asOf - start) / 86_400n : 0n;
  const floorDays = interestRemainingDaysOf(live);
  const days = elapsedDays > floorDays ? elapsedDays : floorDays;
  return (
    live.principal +
    (live.principal * live.interestRateBps * days) / (365n * 10_000n) +
    lateFeeAt(live, asOf)
  );
}

/** The standing-approval target for a refinance request: the payoff
 *  at the LAST moment the request is still fillable — the earlier of
 *  its own expiry and the end of the loan's grace window (a lender
 *  can accept any time up to then, and the accept-time pull includes
 *  the late fee AND the still-accruing grace interest AT THAT TIME,
 *  #1189/#1236). Approving only today's
 *  figure would strand an otherwise-valid request the moment the
 *  loan crosses maturity; approving this bound keeps the approval
 *  exact against the maximum the contract can ever pull for THIS
 *  request. `expiresAt === 0` means no offer-level expiry — the
 *  grace end alone bounds it. */
export function refinanceApprovalOf(
  live: LoanLive,
  opts: { expiresAt: bigint; graceSeconds: bigint },
): bigint {
  const graceEnd = loanEndTimeOf(live) + opts.graceSeconds;
  // acceptOffer rejects at ts >= expiresAt, so the last fillable
  // moment under the offer's own clock is expiresAt - 1.
  const lastFillable =
    opts.expiresAt > 0n && opts.expiresAt - 1n < graceEnd
      ? opts.expiresAt - 1n
      : graceEnd;
  return refinancePayoffOf(live, lastFillable);
}

/** Mirror LibVaipakam.SECONDS_PER_YEAR / BASIS_POINTS. */
export const SECONDS_PER_YEAR = 365n * 86_400n;
export const BASIS_POINTS = 10_000n;

/** Mirrors LibVaipakam.MIN_OFFER_CANCEL_DELAY — cancels inside this
 *  window revert CancelCooldownActive. Protocol-wide (any offer),
 *  not specific to any one flow. */
export const CANCEL_COOLDOWN_SECONDS = 300n;

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

/** What the BUYER of a sale-listed lender position stands to earn if
 *  the borrower repays at maturity: the sale rate applied to the
 *  remaining interest-window seconds — the exact `saleRemainingInterest`
 *  figure `completeLoanSale` settles against, never a fresh-term
 *  projection (the term is part-elapsed; the buyer only earns from
 *  now). One definition so the buy review and any future quote can't
 *  drift from the facet. */
export function saleBuyerRemainingInterest(
  live: LoanLive,
  saleRateBps: bigint,
  chainNow: bigint,
): bigint {
  const start = interestAccrualStartOf(live);
  const elapsed = chainNow > start ? chainNow - start : 0n;
  const totalSecs = interestRemainingDaysOf(live) * 86_400n;
  const remainingSecs = totalSecs > elapsed ? totalSecs - elapsed : 0n;
  return (
    (live.principal * saleRateBps * remainingSecs) /
    (SECONDS_PER_YEAR * BASIS_POINTS)
  );
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
    lender: raw.lender,
    borrower: raw.borrower,
    borrowerTokenId: raw.borrowerTokenId,
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
