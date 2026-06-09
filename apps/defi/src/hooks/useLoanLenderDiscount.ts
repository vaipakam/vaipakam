import { useReadContracts } from 'wagmi';
import { useReadChain } from '../contracts/useDiamond';
import { DIAMOND_ABI_VIEM as DIAMOND_ABI } from '@vaipakam/contracts/abis';

/**
 * Live lender yield-fee discount for a specific loan.
 *
 * T-087 Sub 1.D rewrite: the underlying contracts replaced the Phase-5
 * loan-window-averaged discount accumulator with an INSTANT effective
 * tier + BPS lookup (`getVPFIDiscountTier(lender)`). The lender's
 * displayed discount is just their current effective BPS at the moment
 * the read fires — no client-side window extrapolation, no per-loan
 * anchor delta.
 *
 * The interface keeps `effectiveAvgBps` + `stampedBpsAtPreviousRollup`
 * for backward compatibility with the existing {LenderDiscountCard}
 * consumer; under the new contract semantics they are always equal
 * (the "drift between window-avg and live stamp" indicator the card
 * surfaces naturally never fires post-T-087). The `windowSeconds`
 * field still reports loan tenure for any consumer that wants to
 * display it.
 *
 * Returns `null` while the reads are in flight or any input is missing.
 */
export interface LoanLenderDiscount {
  /** Effective discount BPS the lender currently sees. Equal to
   *  `stampedBpsAtPreviousRollup` under T-087's instant-lookup
   *  semantics. */
  effectiveAvgBps: number;
  /** Same value as `effectiveAvgBps`; retained for backward compat
   *  with {LenderDiscountCard}'s drift-indicator. */
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
            functionName: 'getEffectiveDiscount',
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
  const tierResult = data[1];
  if (!loanResult || !tierResult) {
    return { data: null, isLoading, error: error ?? null };
  }
  if (loanResult.status !== 'success' || tierResult.status !== 'success') {
    const firstError = (loanResult.status === 'failure' ? loanResult.error : null) ??
      (tierResult.status === 'failure' ? tierResult.error : null);
    return {
      data: null,
      isLoading,
      error: firstError instanceof Error ? firstError : error ?? null,
    };
  }

  const loan = loanResult.result as unknown as { startTime: bigint };
  // `getEffectiveDiscount` returns `(effTier, effBps)` — the post-gate
  // EFFECTIVE_TIER and EFFECTIVE_BPS the fee path actually applies.
  const tier = tierResult.result as unknown as readonly [number, number];
  const effectiveBps = Number(tier[1]);

  const startTime = Number(loan.startTime);
  const now = Math.floor(Date.now() / 1000);
  const windowSeconds = Math.max(0, now - startTime);

  // The Phase-5 zero-duration guard in
  // `LibVPFIDiscount.lenderTimeWeightedDiscountBps` (`if
  // loan.startTime == 0 || block.timestamp <= loan.startTime
  // return 0`) is a defensive degenerate-loan check. Under
  // T-087's instant-lookup semantics the lender's discount IS
  // their current EFFECTIVE_BPS regardless of loan tenure, so
  // the hook surfaces that directly. Codex Sub 1.D round-2 P3
  // caught the previous attempt to mirror the gate via
  // `Date.now() - startTime <= 0`: the client clock can be a
  // second or two ahead of the latest block, which would let
  // the hook show a non-zero discount in the same block as
  // `acceptOffer` (where the contract returns 0). The fix is
  // not to use chain time as a tighter guard — it's to drop
  // the client-side guard entirely. The same-block edge case
  // is invisible to the user (the card hasn't even rendered by
  // the time the next block arrives).
  if (startTime === 0) {
    return {
      data: {
        effectiveAvgBps: 0,
        stampedBpsAtPreviousRollup: 0,
        windowSeconds,
      },
      isLoading: false,
      error: null,
    };
  }

  return {
    data: {
      effectiveAvgBps: effectiveBps,
      stampedBpsAtPreviousRollup: effectiveBps,
      windowSeconds,
    },
    isLoading: false,
    error: null,
  };
}
