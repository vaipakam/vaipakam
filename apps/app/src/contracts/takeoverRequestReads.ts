/**
 * #3845 — the live chain reads a takeover request is built against: the
 * platform settings that bound its term, and where its rate sits against
 * the warning band around the term average. Every read throws on failure,
 * so a form never offers terms it could not check (fail closed).
 */
import type { PublicClient } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { readLiveProtocolFees } from '../data/fees';
import {
  takeoverCadence,
  type TakeoverLimits,
  type TakeoverRiskBounds,
  type TakeoverSourceLoan,
} from '../data/takeoverRequest';

/** The longest offer term and the minimum offer age, as the Diamond has
 *  them now. */
export async function readTakeoverLimitsLive(
  publicClient: PublicClient,
  diamondAddress: `0x${string}`,
): Promise<TakeoverLimits> {
  const [fees, minTermsAgeSec] = await Promise.all([
    readLiveProtocolFees(publicClient, diamondAddress),
    publicClient.readContract({
      address: diamondAddress,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'getMinTermsAgeSec',
    }) as Promise<bigint>,
  ]);
  return { maxOfferDurationDays: fees.maxOfferDurationDays, minTermsAgeSec };
}

/** Where a rate sits against the warning band for its term
 *  (`RateLinkFacet.rateWarnings`, the same check posting applies). */
export interface RateBandRead {
  /** Outside the band: posting needs the requester's acknowledgement. */
  far: boolean;
  /** Above the band (only meaningful when `far`). */
  above: boolean;
  /** The term average, in basis points a year. */
  averageBps: number;
}

export async function readRateBandLive(
  publicClient: PublicClient,
  diamondAddress: `0x${string}`,
  asset: `0x${string}`,
  termDays: number,
  rateBps: number,
): Promise<RateBandRead> {
  const [warnings, band] = (await publicClient.readContract({
    address: diamondAddress,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'rateWarnings',
    args: [asset, BigInt(termDays), BigInt(rateBps)],
  })) as readonly [number, { termAverage1e18: bigint; above: boolean }];
  return {
    far: warnings !== 0,
    above: band.above,
    averageBps: Number(band.termAverage1e18 / 10n ** 14n),
  };
}

/** The loan-initiation risk bounds for the request (`initRiskBounds`, the
 *  same bounds creation applies): the least collateral the loan's principal
 *  needs, and the largest principal `collateralAmount` backs. Where the
 *  bounds do not apply (a leg that is not a liquid ERC-20) the chain
 *  answers a zero floor and no cap. */
export async function readTakeoverRiskBoundsLive(
  publicClient: PublicClient,
  diamondAddress: `0x${string}`,
  loan: Pick<TakeoverSourceLoan, 'principalAsset' | 'collateralAsset' | 'principal'>,
  collateralAmount: bigint,
): Promise<TakeoverRiskBounds> {
  const [floor, , amountCap] = (await publicClient.readContract({
    address: diamondAddress,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'initRiskBounds',
    args: [loan.principalAsset, loan.collateralAsset, loan.principal, collateralAmount],
  })) as readonly [bigint, boolean, bigint];
  return { floor, amountCap };
}

/** The payment schedule the request can be posted with
 *  (`previewCadenceAdmission`, the rule creation applies), or null when the
 *  chain admits none for this term. */
export async function readTakeoverCadenceLive(
  publicClient: PublicClient,
  diamondAddress: `0x${string}`,
  loan: Pick<TakeoverSourceLoan, 'principalAsset' | 'assetType' | 'collateralAsset' | 'collateralAssetType' | 'principal'>,
  durationDays: number,
): Promise<number | null> {
  const preview = (await publicClient.readContract({
    address: diamondAddress,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'previewCadenceAdmission',
    args: [
      loan.principalAsset,
      loan.principal,
      loan.assetType,
      loan.collateralAsset,
      loan.collateralAssetType,
      BigInt(durationDays),
    ],
  })) as { cadences: readonly { cadence: number; admitted: boolean }[] };
  const admitted = new Set(preview.cadences.filter((c) => c.admitted).map((c) => Number(c.cadence)));
  return takeoverCadence((c) => admitted.has(c));
}
