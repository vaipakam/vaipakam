import { useQuery } from '@tanstack/react-query';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import {
  DEFAULT_RENTAL_BUFFER_BPS,
  LOAN_INITIATION_FEE_BPS,
  MIN_HEALTH_FACTOR_1E18,
} from '@vaipakam/defi-client';
import type { Address } from 'viem';
import { useDiamondContract, useDiamondPublicClient, useReadChain } from './useDiamond';

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

/** Live minimum health factor (1e18-scaled) from `RiskFacet.getMinHealthFactor`. */
export function useMinHealthFactor1e18() {
  const publicClient = useDiamondPublicClient();
  const chain = useReadChain();

  return useQuery({
    queryKey: ['min-health-factor', chain.chainId, chain.diamondAddress],
    enabled: Boolean(chain.diamondAddress),
    queryFn: async () => {
      const hf = (await publicClient.readContract({
        address: chain.diamondAddress as Address,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'getMinHealthFactor',
      })) as bigint;
      return hf > 0n ? hf : MIN_HEALTH_FACTOR_1E18;
    },
    staleTime: 60_000,
  });
}