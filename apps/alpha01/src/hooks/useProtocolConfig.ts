import { useQuery } from '@tanstack/react-query';
import { LOAN_INITIATION_FEE_BPS } from '@vaipakam/defi-client';
import { useDiamondContract, useReadChain } from './useDiamond';

/** Live loan-initiation fee (BPS) from `ConfigFacet.getProtocolConfigBundle`. */
export function useLoanInitiationFeeBps() {
  const diamond = useDiamondContract();
  const chain = useReadChain();

  return useQuery({
    queryKey: ['loan-initiation-fee-bps', chain.chainId, chain.diamondAddress],
    enabled: Boolean(chain.diamondAddress),
    queryFn: async () => {
      const bundle = (await diamond.getProtocolConfigBundle()) as readonly [bigint, bigint, ...unknown[]];
      const bps = Number(bundle[1]);
      return Number.isFinite(bps) && bps > 0 ? bps : Number(LOAN_INITIATION_FEE_BPS);
    },
    staleTime: 60_000,
  });
}