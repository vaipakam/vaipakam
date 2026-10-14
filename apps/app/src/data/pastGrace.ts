/**
 * Whether a loan's grace period has ended, on the chain's word (#2463
 * follow-up). `DefaultedFacet.isLoanDefaultable(loanId)` is the same read
 * the forced-close card gates on; the grace length behind it is
 * governance-configurable, so no client-side clock can stand in for it.
 *
 * Read for every open loan row (rows are windowed, so a list costs one
 * read per visible open position), and not only for rows this device's
 * clock calls overdue: the contract uses the chain's clock. A failed read is an ERROR, never `false`:
 * the row then keeps its time-based "Past due" badge, which is true either
 * way, rather than asserting the loan is still in grace.
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
    // Grace ends once and does not come back, so a `true` stops polling;
    // until then a minute is fine-grained enough for a list badge.
    refetchInterval: (query) => (query.state.data === true ? false : 60_000),
    queryFn: () =>
      publicClient!.readContract({
        address: readChain.diamondAddress,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'isLoanDefaultable',
        args: [BigInt(loanId)],
      }) as Promise<boolean>,
  });
}
