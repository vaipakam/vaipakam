import { useReadContracts } from 'wagmi';
import { useReadChain } from '../contracts/useDiamond';
import { DIAMOND_ABI_VIEM as DIAMOND_ABI } from '../contracts/abis';

/**
 * Live time-weighted lender yield-fee discount for a specific loan.
 *
 * The value is what the discount WOULD be if the yield fee settled right
 * now. Matches the on-chain math in {LibVPFIDiscount.lenderTimeWeighted
 * DiscountBps} except that the client extrapolates the currently-open
 * period client-side (no rollup has persisted it yet). When the next
 * rollup fires on-chain the value stabilises exactly at this number.
 *
 *   effectiveAvgBps =
 *     (cumulativeDiscountBpsSeconds
 *       + stamped × (now − lastRollupAt)
 *       − loan.lenderDiscountAccAtInit)
 *     / (now − loan.startTime)
 *
 * Design reference: docs/GovernanceConfigDesign.md §5.4 ("Per-loan rollup
 * state in the UI"). Gaming-resistance rationale: §5.2a.
 *
 * Returns `null` while the reads are in flight or any input is missing.
 */
export interface LoanLenderDiscount {
  /** Time-weighted average discount BPS the lender has earned so far. */
  effectiveAvgBps: number;
  /** Currently-stamped BPS — what the next period accrues at until the
   *  lender's next escrow-VPFI mutation triggers a rollup. */
  stampedBpsAtPreviousRollup: number;
  /** Seconds elapsed since loan start. */
  windowSeconds: number;
}

export function useLoanLenderDiscount(
  loanId: bigint | null,
  lender: `0x${string}` | null,
): {
  data: LoanLenderDiscount | null;
  isLoading: boolean;
  error: Error | null;
} {
  const chain = useReadChain();
  const diamondAddress = chain.diamondAddress as `0x${string}` | null;
  const enabled = Boolean(diamondAddress && loanId != null && lender);

  const { data, isLoading, error } = useReadContracts({
    contracts: enabled
      ? [
          {
            abi: DIAMOND_ABI,
            address: diamondAddress!,
            functionName: 'getLoanDetails',
            args: [loanId!],
            chainId: chain.chainId,
          },
          {
            abi: DIAMOND_ABI,
            address: diamondAddress!,
            functionName: 'getUserVpfiDiscountState',
            args: [lender!],
            chainId: chain.chainId,
          },
        ]
      : [],
    query: {
      enabled,
      staleTime: 30_000,
    },
  });

  if (!enabled || !data || data.length < 2) {
    return { data: null, isLoading, error: error ?? null };
  }

  const loanResult = data[0];
  const stateResult = data[1];
  if (!loanResult || !stateResult) {
    return { data: null, isLoading, error: error ?? null };
  }
  if (loanResult.status !== 'success' || stateResult.status !== 'success') {
    const firstError = (loanResult.status === 'failure' ? loanResult.error : null) ??
      (stateResult.status === 'failure' ? stateResult.error : null);
    return {
      data: null,
      isLoading,
      error: firstError instanceof Error ? firstError : error ?? null,
    };
  }

  // `getLoanDetails` returns a tuple-encoded Loan struct. viem with a full
  // ABI surfaces it as an object keyed by field names; we defensively index
  // by key with a bigint fall-through so a future Loan-struct reordering
  // doesn't silently produce wrong numbers.
  const loan = loanResult.result as unknown as {
    startTime: bigint;
    lenderDiscountAccAtInit: bigint;
  };
  const state = stateResult.result as unknown as readonly [number, bigint, bigint];
  const stampedBps = Number(state[0]);
  const lastRollupAt = Number(state[1]);
  const cumulative = state[2];

  const startTime = Number(loan.startTime);
  const accAtInit = loan.lenderDiscountAccAtInit;

  const now = Math.floor(Date.now() / 1000);
  const windowSeconds = Math.max(0, now - startTime);
  if (windowSeconds === 0 || startTime === 0) {
    return {
      data: { effectiveAvgBps: 0, stampedBpsAtPreviousRollup: stampedBps, windowSeconds },
      isLoading,
      error: null,
    };
  }

  // Client-side extrapolation of the currently-open period. Uses BigInt
  // throughout to avoid precision loss on large `cumulative` values; casts
  // down to `number` only for the final BPS result, which is always ≤ 10000.
  const openPeriodContribution = BigInt(stampedBps) * BigInt(Math.max(0, now - lastRollupAt));
  const delta = cumulative + openPeriodContribution - accAtInit;
  const effectiveAvgBps = delta > 0n ? Number(delta / BigInt(windowSeconds)) : 0;

  return {
    data: { effectiveAvgBps, stampedBpsAtPreviousRollup: stampedBps, windowSeconds },
    isLoading: false,
    error: null,
  };
}
