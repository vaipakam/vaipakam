import { useQuery } from '@tanstack/react-query';
import { DEFAULT_RENTAL_BUFFER_BPS, LOAN_INITIATION_FEE_BPS } from '@vaipakam/defi-client';
import { useDiamondContract, useReadChain } from './useDiamond';

/** Live NFT rental prepay buffer (BPS) from `ConfigFacet.getProtocolConfigBundle`. */
export function useRentalBufferBps() {
  const diamond = useDiamondContract();
  const chain = useReadChain();

  return useQuery({
    queryKey: ['rental-buffer-bps', chain.chainId, chain.diamondAddress],
    enabled: Boolean(chain.diamondAddress),
    queryFn: async () => {
      const bundle = (await diamond.getProtocolConfigBundle()) as readonly [
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
        ...unknown[],
      ];
      const bps = Number(bundle[6]);
      return Number.isFinite(bps) && bps >= 0 ? bps : DEFAULT_RENTAL_BUFFER_BPS;
    },
    staleTime: 60_000,
  });
}

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