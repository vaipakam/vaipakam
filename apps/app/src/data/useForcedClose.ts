/**
 * Live reads behind the lender's forced close-out card.
 *
 * Everything here exists to feed `decideForcedClose` FACTS. The
 * decision itself is pure and lives in `forcedClose.ts` so it can be
 * tested without a chain; this module's only job is answering its
 * questions honestly, including answering "I don't know" when a read
 * fails.
 *
 * ## Why each read is a separate query
 *
 * They fail independently and mean different things. Batching them into
 * one query would make a failed LTV read — which happens NORMALLY on
 * illiquid collateral, where `calculateLTV` reverts
 * `IlliquidLoanNoRiskMath` by design — take the defaultability answer
 * down with it, and an illiquid loan is exactly the case where the
 * one-click close-out works. The card would go permanently unknown on
 * the positions it serves best.
 *
 * ## The read that is allowed to fail
 *
 * `calculateLTV` is expected to revert for illiquid collateral, so its
 * failure is reported as `undefined` rather than surfaced. That is safe
 * only because `decideForcedClose` reaches the LTV question ONLY after
 * establishing the collateral is liquid — where a revert is genuinely
 * abnormal and `undefined` correctly becomes `unknown`. If that
 * ordering ever changes, this leniency has to be revisited with it.
 */
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { DIAMOND_ABI_VIEM } from '../contracts/diamond';
import { useActiveChain } from '../chain/useActiveChain';
import { LIQUIDITY_LIQUID } from '../contracts/preflights';

/** Poll cadence. The interesting transitions here are slow — a grace
 *  period expiring, a sequencer recovering — but a lender sitting on
 *  the page as grace lapses should see the card turn actionable
 *  without a manual reload. */
const REFETCH_MS = 30_000;

export interface ForcedCloseReads {
  defaultable: boolean | undefined;
  sequencerHealthy: boolean | undefined;
  collateralIlliquid: boolean | undefined;
  ltvCollapsed: boolean | undefined;
}

export function useForcedCloseReads(opts: {
  loanId: string | number | undefined;
  /** The loan's collateral asset. `undefined` while the loan read is
   *  in flight — every dependent query stays disabled rather than
   *  querying a zero address, which `checkLiquidity` rejects outright
   *  with `InvalidAsset`. */
  collateralAsset: `0x${string}` | undefined;
  /** Only mount these reads for a lender looking at an Active loan.
   *  Everything else pays RPC for an answer nothing renders. */
  enabled: boolean;
}): ForcedCloseReads {
  const { readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  const diamond = readChain.diamondAddress as `0x${string}`;
  const loanId = opts.loanId;
  const on = opts.enabled && loanId !== undefined && Boolean(publicClient);

  const defaultable = useQuery({
    queryKey: ['forcedClose', 'defaultable', readChain.chainId, String(loanId)],
    enabled: on,
    refetchInterval: REFETCH_MS,
    queryFn: async () =>
      (await publicClient!.readContract({
        address: diamond,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'isLoanDefaultable',
        args: [BigInt(loanId!)],
      })) as boolean,
  });

  const sequencer = useQuery({
    queryKey: ['forcedClose', 'sequencer', readChain.chainId],
    enabled: on,
    refetchInterval: REFETCH_MS,
    queryFn: async () =>
      (await publicClient!.readContract({
        address: diamond,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'sequencerHealthy',
      })) as boolean,
  });

  const liquidity = useQuery({
    queryKey: [
      'forcedClose',
      'liquidity',
      readChain.chainId,
      opts.collateralAsset ?? '',
    ],
    enabled: on && Boolean(opts.collateralAsset),
    refetchInterval: REFETCH_MS,
    queryFn: async () => {
      const status = await publicClient!.readContract({
        address: diamond,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'checkLiquidity',
        args: [opts.collateralAsset!],
      });
      return Number(status) !== LIQUIDITY_LIQUID;
    },
  });

  /** LTV against the RESOLVED threshold.
   *
   *  `getRiskConfig` returns `cfgVolatilityLtvThresholdBps()`, which has
   *  already applied the `0 ⇒ VOLATILITY_LTV_THRESHOLD_BPS` default, so
   *  the comparison uses the chain's effective number and this file
   *  carries no copy of 11000. A hard-coded threshold here would be
   *  correct only until governance retuned it — the same trap as
   *  recomputing the grace period locally. */
  const ltv = useQuery({
    queryKey: ['forcedClose', 'ltv', readChain.chainId, String(loanId)],
    enabled: on,
    refetchInterval: REFETCH_MS,
    retry: false,
    queryFn: async () => {
      const [ltvBps, risk] = await Promise.all([
        publicClient!.readContract({
          address: diamond,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'calculateLTV',
          args: [BigInt(loanId!)],
        }) as Promise<bigint>,
        publicClient!.readContract({
          address: diamond,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getRiskConfig',
        }) as Promise<readonly [bigint, bigint]>,
      ]);
      return ltvBps > risk[0];
    },
  });

  return {
    // `isError` disqualifies a cached value rather than ranking below
    // it — the house rule from `loanLive` and the sale lock. A stale
    // "defaultable" retained through a failed refetch would keep a
    // submit button live against a loan whose status may have moved.
    defaultable: defaultable.isError ? undefined : defaultable.data,
    sequencerHealthy: sequencer.isError ? undefined : sequencer.data,
    collateralIlliquid: liquidity.isError ? undefined : liquidity.data,
    ltvCollapsed: ltv.isError ? undefined : ltv.data,
  };
}
