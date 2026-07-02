/**
 * Live protocol fee reads — the review receipts users sign against
 * must quote the DEPLOYED fee values, not compile-time defaults
 * (ConfigFacet.setFeesConfig can retune both). Falls back to the
 * deploy defaults only while the read is in flight; the `ready` flag
 * lets money-critical surfaces distinguish live from fallback.
 *
 * Bundle tuple indices per apps/defi useProtocolConfig BundleTuple:
 * [0] treasuryFeeBps (yield fee), [1] loanInitiationFeeBps.
 */
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { useActiveChain } from '../chain/useActiveChain';

const TREASURY_FEE_BPS_DEFAULT = 100; // 1% of interest
const LIF_BPS_DEFAULT = 10; // 0.1% of principal

export interface ProtocolFees {
  /** Yield fee on lender interest, bps. */
  treasuryFeeBps: number;
  /** Borrower loan-initiation fee, bps. */
  loanInitiationFeeBps: number;
  /** True once the values are live-read (not defaults). */
  ready: boolean;
}

export function useProtocolFees(): ProtocolFees {
  const { readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });

  const { data } = useQuery({
    queryKey: ['protocolFees', readChain.chainId],
    enabled: Boolean(publicClient),
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const bundle = (await publicClient!.readContract({
        address: readChain.diamondAddress,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'getProtocolConfigBundle',
      })) as readonly unknown[];
      return {
        treasuryFeeBps: Number(bundle[0] as bigint),
        loanInitiationFeeBps: Number(bundle[1] as bigint),
      };
    },
  });

  return {
    treasuryFeeBps: data?.treasuryFeeBps ?? TREASURY_FEE_BPS_DEFAULT,
    loanInitiationFeeBps: data?.loanInitiationFeeBps ?? LIF_BPS_DEFAULT,
    ready: data !== undefined,
  };
}

export function bpsToPercentText(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`;
}
