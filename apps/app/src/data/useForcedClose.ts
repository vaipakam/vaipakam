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
  paused: boolean | undefined;
  consentFromBoth: boolean | undefined;
  internalMatchCandidate: boolean | undefined;
  collateralIlliquid: boolean | undefined;
  ltvCollapsed: boolean | undefined;
  /** When the read that decides ACTIONABILITY last returned.
   *
   *  `defaultable` alone, deliberately. The card uses this to release
   *  its post-submit hold, and the question it is really asking is
   *  "has anything been read since I submitted?" — a value that only
   *  moved because a different query settled would answer yes without
   *  the actionability verdict having been rechecked at all. Zero
   *  while the read has never returned, which reads as "no evidence
   *  yet" at every comparison site. */
  updatedAt: number;
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

  /** `AdminFacet.paused()` — `triggerDefault`'s first modifier.
   *
   *  Chain-scoped, not loan-scoped, and read at the same cadence as the
   *  rest so a governance pause during the lender's visit removes the
   *  button rather than leaving one that is guaranteed to revert. */
  const paused = useQuery({
    queryKey: ['forcedClose', 'paused', readChain.chainId],
    enabled: on,
    refetchInterval: REFETCH_MS,
    queryFn: async () =>
      (await publicClient!.readContract({
        address: diamond,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'paused',
      })) as boolean,
  });

  /** `loan.riskAndTermsConsentFromBoth`, straight off the loan struct.
   *
   *  Read HERE rather than taken from the page's `loanLive`, which is
   *  Advanced-mode only — sourcing it there would have left the flag
   *  permanently undefined in Basic mode and stalled the card on
   *  `unknown` for exactly the lenders least likely to know why. It is
   *  set at init and never changes, so a long staleTime is correct;
   *  the poll cadence is kept only for the shared invalidation key. */
  const consent = useQuery({
    queryKey: ['forcedClose', 'consent', readChain.chainId, String(loanId)],
    enabled: on,
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const live = (await publicClient!.readContract({
        address: diamond,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'getLoanDetails',
        args: [BigInt(loanId!)],
      })) as { riskAndTermsConsentFromBoth: boolean };
      return Boolean(live.riskAndTermsConsentFromBoth);
    },
  });

  /** `MetricsFacet.hasInternalMatchCandidate(loanId)` — the same view
   *  `attemptInternalMatchAutoDispatch` consults before it reaches the
   *  swap branch, so this predicts that dispatch exactly rather than
   *  modelling it. It already folds in the `internalMatchEnabled`
   *  config flag and the matchable-collateral filter.
   *
   *  Polled at the normal cadence: a candidate is another live loan and
   *  can appear or vanish while the lender is looking. The confirm-time
   *  simulation is what covers the gap between this read and the send. */
  const internalMatch = useQuery({
    queryKey: ['forcedClose', 'match', readChain.chainId, String(loanId)],
    enabled: on,
    refetchInterval: REFETCH_MS,
    queryFn: async () => {
      const [found] = (await publicClient!.readContract({
        address: diamond,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'hasInternalMatchCandidate',
        args: [BigInt(loanId!)],
      })) as readonly [boolean, bigint];
      return found;
    },
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
    paused: paused.isError ? undefined : paused.data,
    consentFromBoth: consent.isError ? undefined : consent.data,
    internalMatchCandidate: internalMatch.isError ? undefined : internalMatch.data,
    collateralIlliquid: liquidity.isError ? undefined : liquidity.data,
    ltvCollapsed: ltv.isError ? undefined : ltv.data,
    updatedAt: defaultable.dataUpdatedAt,
  };
}
