/**
 * Loan risk reads — RiskFacet's `calculateHealthFactor(loanId)` /
 * `calculateLTV(loanId)`. Both REVERT for loans whose legs aren't
 * priceable (illiquid); that's not an error, it's the protocol saying
 * "no automatic liquidation applies here", and the UI copy reflects
 * exactly that instead of showing a spinner forever.
 *
 * HF and LTV are 1e18-scaled ratios.
 */
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { useActiveChain } from '../chain/useActiveChain';
import { copy } from '../content/copy';

export interface LoanRisk {
  /** False when the reads reverted → illiquid legs, no HF applies. */
  priced: boolean;
  healthFactor: bigint;
  ltv: bigint;
}

export function useLoanRisk(loanId: number | undefined, enabled: boolean) {
  const { readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });

  return useQuery({
    queryKey: ['loanRisk', readChain.chainId, loanId],
    enabled: enabled && loanId !== undefined && Boolean(publicClient),
    // Stop polling once a loan is known unpriceable — that
    // classification doesn't change for an open loan.
    refetchInterval: (query) =>
      query.state.data?.priced === false ? false : 60_000,
    queryFn: async (): Promise<LoanRisk> => {
      try {
        const [healthFactor, ltv] = await Promise.all([
          publicClient!.readContract({
            address: readChain.diamondAddress,
            abi: DIAMOND_ABI_VIEM,
            functionName: 'calculateHealthFactor',
            args: [BigInt(loanId!)],
          }) as Promise<bigint>,
          publicClient!.readContract({
            address: readChain.diamondAddress,
            abi: DIAMOND_ABI_VIEM,
            functionName: 'calculateLTV',
            args: [BigInt(loanId!)],
          }) as Promise<bigint>,
        ]);
        return { priced: true, healthFactor, ltv };
      } catch (err) {
        // ONLY an on-chain revert means "illiquid legs — HF doesn't
        // apply". Anything else (RPC outage, timeout, rate limit) must
        // surface as a query ERROR, never as priced:false — otherwise
        // a flaky RPC shows a liquid, possibly liquidatable loan as
        // "no automatic liquidation applies".
        const isRevert =
          err instanceof BaseError &&
          (err.walk((e) => e instanceof ContractFunctionRevertedError) !== null ||
            err.walk((e) => e instanceof ContractFunctionZeroDataError) !== null);
        if (isRevert) return { priced: false, healthFactor: 0n, ltv: 0n };
        throw err;
      }
    },
  });
}

const WAD = 10n ** 18n;

export interface HealthView {
  label: string;
  badge: 'ok' | 'warn' | 'danger';
  /** e.g. "1.82" */
  ratio: string;
  /** e.g. "55%" */
  ltvPct: string;
}

/** Plain-language health labels; thresholds mirror the protocol:
 *  liquidation at HF < 1.0, admission floor 1.5. */
export function healthView(risk: LoanRisk): HealthView {
  const hf = risk.healthFactor;
  const label =
    hf < WAD
      ? copy.risk.liquidatable
      : hf < (11n * WAD) / 10n
        ? copy.risk.danger
        : hf < (15n * WAD) / 10n
          ? copy.risk.watch
          : copy.risk.healthy;
  const badge: HealthView['badge'] =
    hf < WAD ? 'danger' : hf < (15n * WAD) / 10n ? 'warn' : 'ok';
  return {
    label,
    badge,
    ratio: (Number(hf) / 1e18).toFixed(2),
    ltvPct: `${Math.round(Number(risk.ltv) / 1e16)}%`,
  };
}
