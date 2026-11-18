/**
 * #3722 / #3727 — the contract's own referral views, for the invite flow
 * and the inviter's page.
 *
 *  - `getReferral(wallet)`: the wallet's inviter, the end time its binding
 *    fixed, whether that period is running, and whether it has already
 *    opened a loan as borrower (which ends the chance to bind).
 *  - `getReferralSettings()`: the rates and the period in force NOW. They
 *    describe what a binding made now would carry; an existing binding's
 *    end time is its own, never derived from these.
 */
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { useActiveChain } from '../chain/useActiveChain';

export interface WalletReferral {
  inviter: `0x${string}`;
  endsAt: number;
  active: boolean;
  hasBorrowed: boolean;
}

export interface ReferralSettings {
  cutBps: number;
  shareBps: number;
  periodDays: number;
}

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export const walletReferralKey = (chainId: number, wallet: string | undefined) =>
  ['walletReferral', chainId, wallet?.toLowerCase()] as const;

export function useWalletReferral(wallet: string | undefined) {
  const { readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  return useQuery({
    queryKey: walletReferralKey(readChain.chainId, wallet),
    enabled: Boolean(wallet && publicClient && readChain.diamondAddress),
    retry: 1,
    queryFn: async (): Promise<WalletReferral> => {
      const v = (await publicClient!.readContract({
        address: readChain.diamondAddress,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'getReferral',
        args: [wallet as `0x${string}`],
      })) as { inviter: `0x${string}`; endsAt: bigint | number; active: boolean; hasBorrowed: boolean };
      return {
        inviter: v.inviter,
        endsAt: Number(v.endsAt),
        active: v.active,
        hasBorrowed: v.hasBorrowed,
      };
    },
  });
}

export function useReferralSettings() {
  const { readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  return useQuery({
    queryKey: ['referralSettings', readChain.chainId],
    enabled: Boolean(publicClient && readChain.diamondAddress),
    retry: 1,
    queryFn: async (): Promise<ReferralSettings> => {
      const [cutBps, shareBps, periodDays] = (await publicClient!.readContract({
        address: readChain.diamondAddress,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'getReferralSettings',
      })) as readonly [bigint, bigint, bigint, bigint];
      return { cutBps: Number(cutBps), shareBps: Number(shareBps), periodDays: Number(periodDays) };
    },
  });
}

/**
 * The chain's latest block and the timestamp of the block the record is
 * current to. Days left and "ended" are compared with chain time, and the
 * record's lag is measured between the two blocks, not against this
 * browser's clock.
 */
export function useChainClock(indexedBlock: number | null | undefined) {
  const { readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  return useQuery({
    queryKey: ['referralChainClock', readChain.chainId, indexedBlock ?? null],
    enabled: Boolean(publicClient),
    refetchInterval: 60_000,
    retry: 1,
    queryFn: async () => {
      const head = await publicClient!.getBlock({ blockTag: 'latest' });
      let indexedTimestamp: number | null = null;
      if (typeof indexedBlock === 'number') {
        try {
          const b = await publicClient!.getBlock({ blockNumber: BigInt(indexedBlock) });
          indexedTimestamp = Number(b.timestamp);
        } catch {
          indexedTimestamp = null;
        }
      }
      return { headTimestamp: Number(head.timestamp), indexedTimestamp };
    },
  });
}
