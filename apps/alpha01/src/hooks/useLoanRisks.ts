import { useQuery } from '@tanstack/react-query';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { batchCalls, encodeBatchCalls } from '@vaipakam/lib/multicall';
import type { Address } from 'viem';
import { useDiamondPublicClient, useReadChain } from './useDiamond';

export interface LoanRiskSnapshot {
  ltvBps: bigint | null;
  healthFactor: bigint | null;
}

/**
 * Batch-read `calculateLTV` + `calculateHealthFactor` for visible loans.
 * One multicall round-trip per metric — used by Advanced portfolio/position views.
 */
export function useLoanRisks(loanIds: number[]) {
  const chain = useReadChain();
  const publicClient = useDiamondPublicClient();
  const diamond = chain.diamondAddress as Address | undefined;
  const idsKey = loanIds.join(',');

  return useQuery({
    queryKey: ['loan-risks', chain.chainId, diamond, idsKey],
    enabled: Boolean(diamond) && loanIds.length > 0,
    queryFn: async () => {
      if (!diamond || loanIds.length === 0) return new Map<number, LoanRiskSnapshot>();

      const argsList = loanIds.map((id) => [BigInt(id)] as const);
      const ltvCalls = encodeBatchCalls(diamond, DIAMOND_ABI_VIEM, 'calculateLTV', argsList);
      const hfCalls = encodeBatchCalls(
        diamond,
        DIAMOND_ABI_VIEM,
        'calculateHealthFactor',
        argsList,
      );
      const [ltvs, hfs] = await Promise.all([
        batchCalls<bigint>(publicClient, DIAMOND_ABI_VIEM, 'calculateLTV', ltvCalls),
        batchCalls<bigint>(publicClient, DIAMOND_ABI_VIEM, 'calculateHealthFactor', hfCalls),
      ]);

      const map = new Map<number, LoanRiskSnapshot>();
      for (let i = 0; i < loanIds.length; i++) {
        map.set(loanIds[i], {
          ltvBps: ltvs[i] ?? null,
          healthFactor: hfs[i] ?? null,
        });
      }
      return map;
    },
    staleTime: 15_000,
  });
}