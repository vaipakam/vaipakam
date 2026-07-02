/**
 * Live protocol config reads. Copy that quotes a fee/buffer must use
 * these, never a hardcoded number — governance can retune them.
 */
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { useActiveChain } from '../chain/useActiveChain';

/** Deploy default (5%) — used only until the live read lands. */
const RENTAL_BUFFER_BPS_DEFAULT = 500;

/** NFT-rental prepay buffer in bps, read from
 *  `ConfigFacet.getProtocolConfigBundle` (tuple index 6 — see
 *  apps/defi useProtocolConfig's BundleTuple). */
export function useRentalBufferBps(): number {
  const { readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });

  const { data } = useQuery({
    queryKey: ['rentalBufferBps', readChain.chainId],
    enabled: Boolean(publicClient),
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<number> => {
      const bundle = (await publicClient!.readContract({
        address: readChain.diamondAddress,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'getProtocolConfigBundle',
      })) as readonly unknown[];
      return Number(bundle[6] as bigint);
    },
  });

  return data ?? RENTAL_BUFFER_BPS_DEFAULT;
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
