/**
 * Whether a loan's grace period has ended, on the chain's word (#2463
 * follow-up). `DefaultedFacet.isLoanDefaultable(loanId)` is the same read
 * the forced-close card gates on; the grace length behind it is
 * governance-configurable, so no client-side clock can stand in for it.
 *
 * Read for every open loan row (rows are windowed, so a list costs one
 * read per visible open position), and not only for rows this device's
 * clock calls overdue: the contract uses the chain's clock. A failed or
 * pending read is an ERROR, never `false`: the row then keeps its
 * time-based badge (by this device's clock), rather than asserting either
 * way what the chain has not said.
 *
 * What a `true` establishes is TIME eligibility only. `triggerDefault` can
 * still refuse for reasons this read does not see (a pause, a sequencer
 * outage, a KYC gate), so copy built on it says the close-out "may" be
 * possible and defers to the position page.
 */
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { useActiveChain } from '../chain/useActiveChain';

export function useLoanPastGrace(loanId: number, enabled: boolean) {
  const { readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  return useQuery({
    queryKey: ['loanPastGrace', readChain.chainId, loanId],
    enabled: enabled && Boolean(publicClient),
    // Polled in BOTH states. A `true` is not final: governance can lengthen
    // the grace schedule (`setGraceBuckets` / `clearGraceBuckets`), which
    // re-derives an open loan's deadline and can reopen ordinary repayment.
    // A minute is fine-grained enough for a list badge.
    refetchInterval: 60_000,
    queryFn: () =>
      publicClient!.readContract({
        address: readChain.diamondAddress,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'isLoanDefaultable',
        args: [BigInt(loanId)],
      }) as Promise<boolean>,
  });
}
