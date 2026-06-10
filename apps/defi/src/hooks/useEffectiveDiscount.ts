import { useReadContract } from 'wagmi';
import { useReadChain } from '../contracts/useDiamond';
import { DIAMOND_ABI_VIEM as DIAMOND_ABI } from '@vaipakam/contracts/abis';

/**
 * T-087 Sub 4 — user-scoped `getEffectiveDiscount` read.
 *
 * Reads `(effTier, effBps)` for `user`. Drives every tier-display
 * surface uniformly: the dashboard's "your current tier" widget,
 * the LenderDiscountCard, and (via the existing
 * {useLoanLenderDiscount} hook) the per-loan lender preview.
 *
 * Returns `null` while the read is in flight or `user` is missing.
 */
export interface EffectiveDiscount {
  /** Post-gate EFFECTIVE_TIER (0-4). */
  tier: number;
  /** Post-gate EFFECTIVE_BPS the fee path actually applies. */
  bps: number;
}

export function useEffectiveDiscount(
  user: `0x${string}` | null | undefined,
): {
  data: EffectiveDiscount | null;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<unknown>;
} {
  const chain = useReadChain();
  const diamondAddress = chain.diamondAddress as `0x${string}` | null;
  const enabled = Boolean(diamondAddress && user);

  const { data, isLoading, error, refetch } = useReadContract({
    abi: DIAMOND_ABI,
    address: diamondAddress ?? undefined,
    functionName: 'getEffectiveDiscount',
    args: user ? [user] : undefined,
    chainId: chain.chainId,
    query: {
      enabled,
      staleTime: 30_000,
    },
  });

  if (!enabled || !data) {
    return { data: null, isLoading, error: error ?? null, refetch };
  }

  const tuple = data as unknown as readonly [number, number];
  return {
    data: { tier: Number(tuple[0]), bps: Number(tuple[1]) },
    isLoading: false,
    error: null,
    refetch,
  };
}
