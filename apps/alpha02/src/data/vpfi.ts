/**
 * VPFI snapshot for the current read chain + connected wallet, in one
 * react-query round-trip:
 *   - registration (`getVPFIToken`; zero address = the chain can't
 *     accept VPFI yet → the page's availability-first state)
 *   - wallet + vault balances
 *   - effective vs raw discount tier (the fee path applies the
 *     EFFECTIVE tier — a 30-day average behind a 3-day minimum-history
 *     gate — so raw > effective means "still warming up", and the UI
 *     must say so instead of promising the raw tier)
 *   - the platform-level discount consent flag
 *
 * VPFI is 18-decimals on every deploy (OFT-mesh requirement).
 */
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { useActiveChain } from '../chain/useActiveChain';

export const VPFI_DECIMALS = 18;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface VpfiSnapshot {
  registered: boolean;
  token: `0x${string}` | null;
  /** Connected wallet's VPFI (0n when disconnected/unregistered). */
  walletBalance: bigint;
  /** Protocol-tracked VPFI in the user's vault (what discounts read). */
  vaultBalance: bigint;
  /** Effective tier (0..4) — what fee settlement actually applies. */
  effectiveTier: number;
  /** Effective discount in bps (e.g. 1000 = 10%). */
  effectiveBps: number;
  /** Raw tier from the tracked vault balance, pre-history-gate. */
  rawTier: number;
  /** Platform-level consent flag; discounts are 0 while false. */
  consent: boolean;
}

export function useVpfi() {
  const { readChain, address } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });

  return useQuery({
    queryKey: ['vpfi', readChain.chainId, address?.toLowerCase()],
    enabled: Boolean(publicClient),
    refetchInterval: 30_000,
    queryFn: async (): Promise<VpfiSnapshot> => {
      if (!publicClient) throw new Error('unreachable');
      const diamond = readChain.diamondAddress;
      const read = <T,>(functionName: string, args: readonly unknown[] = []) =>
        publicClient.readContract({
          address: diamond,
          abi: DIAMOND_ABI_VIEM,
          functionName,
          args: args as unknown[],
        }) as Promise<T>;

      const token = await read<`0x${string}`>('getVPFIToken');
      const registered = token.toLowerCase() !== ZERO_ADDRESS;
      if (!registered || !address) {
        return {
          registered,
          token: registered ? token : null,
          walletBalance: 0n,
          vaultBalance: 0n,
          effectiveTier: 0,
          effectiveBps: 0,
          rawTier: 0,
          consent: false,
        };
      }

      const [walletBalance, effective, tracked, consent] = await Promise.all([
        read<bigint>('getVPFIBalanceOf', [address]),
        read<readonly [number, number]>('getEffectiveDiscount', [address]),
        read<readonly [bigint, bigint, bigint]>('getTrackedVPFIDiscountTier', [
          address,
        ]),
        read<boolean>('getVPFIDiscountConsent', [address]),
      ]);
      const [effTier, effBps] = effective;
      const [trackedTier, trackedBal] = tracked;

      return {
        registered,
        token,
        walletBalance,
        vaultBalance: trackedBal,
        effectiveTier: Number(effTier),
        effectiveBps: Number(effBps),
        rawTier: Number(trackedTier),
        consent,
      };
    },
  });
}
