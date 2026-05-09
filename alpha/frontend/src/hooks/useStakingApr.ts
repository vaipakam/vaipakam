import { useCallback, useEffect, useState } from 'react';
import type { Address } from 'viem';
import { useDiamondPublicClient, useReadChain } from '../contracts/useDiamond';
import { DEFAULT_CHAIN } from '../contracts/config';
import { DIAMOND_ABI_VIEM as DIAMOND_ABI } from '../contracts/abis';

const DEFAULT_APR_BPS = 500n; // 5% — matches the contract's compile-time default.

/**
 * Single-read hook returning the live VPFI staking APR for the active
 * read-chain. Defined separately from `useStakingRewards` so call sites
 * that need ONLY the APR (e.g. tooltip / explainer copy on pages where
 * the wallet may not be connected) don't pay the cost of the four
 * staking-rewards reads, and so the APR can be interpolated into UI
 * strings without tying them to a wallet-aware hook.
 *
 * Returns:
 *   - `aprBps`  — basis points (e.g. 500 = 5.00%)
 *   - `aprPct`  — formatted percentage string ("5" / "5.75") suitable for
 *                 dropping into i18n placeholders
 *
 * Falls back to the contract default (500 / 5%) on revert (older
 * Diamond deploys without the facet).
 */
export function useStakingApr(): { aprBps: bigint; aprPct: string } {
  const publicClient = useDiamondPublicClient();
  const chain = useReadChain();
  const diamondAddress = (chain.diamondAddress ?? DEFAULT_CHAIN.diamondAddress) as Address;
  const [aprBps, setAprBps] = useState<bigint>(DEFAULT_APR_BPS);

  const load = useCallback(async () => {
    try {
      const v = (await publicClient.readContract({
        address: diamondAddress,
        abi: DIAMOND_ABI,
        functionName: 'getStakingAPRBps',
        args: [],
      })) as bigint;
      setAprBps(v ?? DEFAULT_APR_BPS);
    } catch {
      setAprBps(DEFAULT_APR_BPS);
    }
  }, [publicClient, diamondAddress]);

  useEffect(() => { load(); }, [load]);

  // 500 → "5", 575 → "5.75". Whole-number BPS render without a decimal
  // point so the most common case (governance-default 5%) reads
  // cleanly; fractional rates get up to 2 decimals.
  const aprPct = aprBps % 100n === 0n
    ? (aprBps / 100n).toString()
    : (Number(aprBps) / 100).toFixed(2);

  return { aprBps, aprPct };
}
