/**
 * Sanctions screening read — `ProfileFacet.isSanctionedAddress(who)`.
 * FAIL-OPEN by design (matches the contract's posture): no oracle
 * configured, read error, or disconnected wallet all report
 * not-flagged, and the banner renders nothing. The full explanation
 * is shown ONLY to a flagged wallet — never on marketing surfaces
 * (retail-deploy policy in CLAUDE.md).
 */
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { useActiveChain } from '../chain/useActiveChain';

export function useSanctionsCheck(): boolean {
  const { readChain, address } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });

  const { data } = useQuery({
    queryKey: ['sanctions', readChain.chainId, address?.toLowerCase()],
    enabled: Boolean(address) && Boolean(publicClient),
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<boolean> => {
      try {
        return (await publicClient!.readContract({
          address: readChain.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'isSanctionedAddress',
          args: [address!],
        })) as boolean;
      } catch {
        return false; // fail open
      }
    },
  });

  return data ?? false;
}
