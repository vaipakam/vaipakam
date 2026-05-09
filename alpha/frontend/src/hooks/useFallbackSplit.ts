import { useReadContract } from 'wagmi';
import { useReadChain } from '../contracts/useDiamond';
import { DIAMOND_ABI_VIEM as DIAMOND_ABI } from '../contracts/abis';

/**
 * Reads the current effective fallback-path settlement split from the
 * Diamond — the governance-configurable knobs that decide how much
 * collateral the lender and treasury receive on the post-liquidation-retry
 * fallback path (see docs/GovernanceConfigDesign.md §5.3 + README §7).
 *
 * These are the **live** values. For a specific existing loan the
 * snapshotted values on the `Loan` struct are authoritative (prospective
 * semantics — a governance change via `ConfigFacet.setFallbackSplit`
 * never retroactively rewrites the terms a loan was opened under). Use
 * this hook where the UI is explaining "what terms would apply to a NEW
 * loan opened right now?" — not for per-loan display.
 *
 * Written native wagmi/viem so Phase B-full doesn't have to touch it.
 */
export function useFallbackSplit() {
  const chain = useReadChain();
  const diamondAddress = chain.diamondAddress as `0x${string}` | null;

  const { data, isLoading, error, refetch } = useReadContract({
    abi: DIAMOND_ABI,
    address: diamondAddress ?? undefined,
    functionName: 'getFallbackSplit',
    chainId: chain.chainId,
    query: {
      enabled: Boolean(diamondAddress),
      staleTime: 60_000,
    },
  });

  const pair = data as readonly [bigint, bigint] | undefined;
  return {
    lenderBonusBps: pair ? Number(pair[0]) : null,
    treasuryBps: pair ? Number(pair[1]) : null,
    /** Combined BPS — useful for "your collateral remainder after fallback" maths. */
    combinedBps: pair ? Number(pair[0]) + Number(pair[1]) : null,
    isLoading,
    error: error ?? null,
    refetch,
  };
}
