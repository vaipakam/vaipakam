import { useQuery } from '@tanstack/react-query';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import type { Address } from 'viem';
import { useDiamondPublicClient, useReadChain } from './useDiamond';

export function useLoanHealth(loanId: number | undefined) {
  const chain = useReadChain();
  const publicClient = useDiamondPublicClient();

  return useQuery({
    queryKey: ['loan-hf', chain.chainId, loanId],
    enabled: loanId != null && Boolean(chain.diamondAddress),
    queryFn: async () => {
      if (loanId == null || !chain.diamondAddress) return null;
      return (await publicClient.readContract({
        address: chain.diamondAddress as Address,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'calculateHealthFactor',
        args: [BigInt(loanId)],
      })) as bigint;
    },
    staleTime: 15_000,
  });
}