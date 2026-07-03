/**
 * Live protocol config reads. Copy that quotes a fee/buffer must use
 * these, never a hardcoded number — governance can retune them.
 */
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import type { PublicClient } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { useActiveChain } from '../chain/useActiveChain';
import { readGraceSecondsLive } from '../contracts/preflights';
import { defaultGraceSeconds, formatGraceSeconds } from '../lib/grace';

/** Deploy default (5%) — display fallback only. Money paths must use
 *  {@link readRentalBufferBps} or gate on `ready`. */
const RENTAL_BUFFER_BPS_DEFAULT = 500;

/** Direct read of the LIVE buffer — for submit paths. Throws on read
 *  failure instead of substituting a default: an under-read buffer
 *  under-approves the renter's prepay and the accept reverts AFTER the
 *  user signed (governance can raise the buffer to 2,000 bps). */
export async function readRentalBufferBps(
  publicClient: PublicClient,
  diamondAddress: `0x${string}`,
): Promise<number> {
  const bundle = (await publicClient.readContract({
    address: diamondAddress,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getProtocolConfigBundle',
  })) as readonly unknown[];
  return Number(bundle[6] as bigint);
}

/** NFT-rental prepay buffer in bps (tuple index 6 of
 *  `getProtocolConfigBundle` — see apps/defi useProtocolConfig's
 *  BundleTuple). `ready` is false while the value is still the
 *  fallback — display may proceed, signing must not. */
export function useRentalBufferBps(): { bps: number; ready: boolean } {
  const { readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });

  const { data } = useQuery({
    queryKey: ['rentalBufferBps', readChain.chainId],
    enabled: Boolean(publicClient),
    staleTime: 5 * 60_000,
    queryFn: () => readRentalBufferBps(publicClient!, readChain.diamondAddress),
  });

  return { bps: data ?? RENTAL_BUFFER_BPS_DEFAULT, ready: data !== undefined };
}

/** LIVE grace label for receipts — governance can override the
 *  default schedule with buckets, and the shown grace must match the
 *  window repayment is actually judged against. The label falls back
 *  to the default-schedule wording while loading (identical on
 *  deploys with no buckets configured) so DISPLAY can proceed, but
 *  `ready` stays false until the live bucket answer lands — SIGNING
 *  must gate on it, exactly like {@link useRentalBufferBps}: on a
 *  chain with retuned buckets the fallback label is a wrong term. */
export function useGraceLabel(durationDays: number): {
  label: string;
  ready: boolean;
  isError: boolean;
  refetch: () => void;
} {
  const { readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  const { data, isError, refetch } = useQuery({
    queryKey: ['graceSeconds', readChain.chainId, durationDays],
    enabled: Boolean(publicClient) && durationDays > 0,
    staleTime: 5 * 60_000,
    queryFn: () =>
      readGraceSecondsLive({
        publicClient: publicClient!,
        diamondAddress: readChain.diamondAddress,
        durationDays,
      }),
  });
  return {
    label: formatGraceSeconds(data ?? defaultGraceSeconds(durationDays)),
    ready: data !== undefined,
    isError,
    refetch: () => void refetch(),
  };
}

/** Renter's total up-front payment for a rental:
 *  dailyFee × days, plus the refundable buffer. Mirrors OfferFacet's
 *  pull (`amount * durationDays * (BPS + buffer) / BPS`). */
export function totalRentalPrepay(
  dailyFeeWei: bigint,
  durationDays: number,
  bufferBps: number,
): bigint {
  const base = dailyFeeWei * BigInt(durationDays);
  return (base * (10_000n + BigInt(bufferBps))) / 10_000n;
}
