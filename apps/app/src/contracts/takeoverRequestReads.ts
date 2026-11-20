/**
 * #3845 — the live chain reads a takeover request is built against: the
 * platform settings that bound its term, and where its rate sits against
 * the warning band around the term average. Every read throws on failure,
 * so a form never offers terms it could not check (fail closed).
 */
import type { PublicClient } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { readLiveProtocolFees } from '../data/fees';
import type { TakeoverLimits } from '../data/takeoverRequest';

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
