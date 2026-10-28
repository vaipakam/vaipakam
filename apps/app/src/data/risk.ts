/**
 * Loan risk reads — RiskFacet's `calculateHealthFactor(loanId)` /
 * `calculateLTV(loanId)`, and on the position page the collateral price
 * the liquidation price is derived from (#2531). Both risk reads REVERT for
 * loans whose legs aren't priceable (illiquid); that's not an error, it's
 * the protocol saying "no automatic liquidation applies here", and the UI
 * copy reflects exactly that instead of showing a spinner forever.
 *
 * Every read is one Multicall3 aggregate (`loanRiskReads.ts`), so the
 * health factor, the LTV and the price behind the liquidation price share
 * one block, and a revert is told from a provider failure by the slot's
 * own status rather than by error class.
 *
 * HF and LTV are 1e18-scaled ratios.
 */
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { useActiveChain } from '../chain/useActiveChain';
import { tipAware } from '../chain/railHealth';
import { readAggregate } from '../contracts/aggregate';
import { copy } from '../content/copy';
import { formatTokenAmountUp } from '../lib/format';
import {
  loanRiskFromSlots,
  loanRiskReadPlan,
  type LoanRisk,
  type RiskCollateral,
} from './loanRiskReads';

export type { LiquidationPrice, LoanRisk, RiskCollateral } from './loanRiskReads';

/** `collateral`, when given, adds the liquidation price to the read. Only
 *  the position page passes it; list rows read the health factor alone. */
export function useLoanRisk(
  loanId: number | undefined,
  enabled: boolean,
  collateral?: RiskCollateral,
) {
  const { readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });

  return useQuery({
    // The collateral is part of the key because it changes the plan.
    queryKey: [
      'loanRisk',
      readChain.chainId,
      loanId,
      collateral?.asset.toLowerCase() ?? '',
      collateral?.decimals ?? '',
    ],
    enabled: enabled && loanId !== undefined && Boolean(publicClient),
    // Stop polling once a loan is known unpriceable — that
    // classification doesn't change for an open loan. Otherwise the
    // cadence is tipAware (RPC read-diet PR A, Codex #1228 r5): the
    // root is in the tip subset, so the per-block nudge carries HF/LTV
    // freshness while both rails deliver and 60s stands as the
    // fallback.
    refetchInterval: (query) =>
      query.state.data?.priced === false
        ? false
        : tipAware(60_000, Boolean(readChain.wsUrl))(),
    queryFn: async (): Promise<LoanRisk> => {
      const plan = loanRiskReadPlan({
        diamond: readChain.diamondAddress as `0x${string}`,
        loanId: BigInt(loanId!),
        collateral,
      });
      // ONLY an on-chain revert means "illiquid legs — HF doesn't
      // apply", and inside the aggregate that is exactly a slot whose
      // status is `failure`. Anything else (RPC outage, timeout, rate
      // limit) rejects `readAggregate` and surfaces as a query ERROR,
      // never as priced:false — otherwise a flaky RPC shows a liquid,
      // possibly liquidatable loan as "no automatic liquidation applies",
      // and stops polling it. (viem's own `multicall` with `allowFailure`
      // cannot tell the two apart: it fails every slot of a request that
      // did not complete.)
      const slots = await readAggregate(
        publicClient!,
        plan.map((e) => e.contract),
      );
      return loanRiskFromSlots(plan, slots);
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
  /** How far the collateral's VALUE can fall before liquidation
   *  (health factor 1.0) — e.g. "45%". Health scales linearly with
   *  collateral value, so the drop is 1 − 1/HF; null when already
   *  at/below the liquidation line. Derived, no price feed needed —
   *  and therefore approximate if the LOAN side's value also moves. */
  dropToLiquidationPct: string | null;
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
    // Suppressed below 1% — "falls about 0%" next to a non-liquidatable
    // badge reads as a contradiction exactly for the borrower hovering
    // at the line, who needs clarity most.
    dropToLiquidationPct: (() => {
      if (hf <= WAD) return null;
      const pct = Math.round((1 - 1e18 / Number(hf)) * 100);
      return pct >= 1 ? `${pct}%` : null;
    })(),
  };
}

/**
 * The liquidation-price sentence for the position page (#2531). Every
 * branch states what it knows or why it has no figure; no branch renders a
 * zero price.
 *
 * `collateralSymbol` is `undefined` when the collateral token's details
 * could not be read, in which case the read was never asked for the price
 * and `risk.liquidationPrice` is absent.
 */
export function liquidationPriceText(
  risk: LoanRisk,
  collateralSymbol: string | undefined,
): string {
  if (!risk.priced) return copy.risk.liquidationPriceNotPriced;
  const lp = risk.liquidationPrice;
  if (lp === undefined || collateralSymbol === undefined) {
    return copy.risk.liquidationPriceTokenUnknown;
  }
  switch (lp.kind) {
    case 'none':
      return copy.risk.liquidationPriceNone;
    case 'unknown':
      return copy.risk.liquidationPriceUnknown;
    case 'priced': {
      // Rounded UP at the shown precision too: `perUnitWad` is already a
      // ceiling, and a to-nearest display would undo it (33.3333…34 shown
      // as 33.3333, below the line).
      const price = formatTokenAmountUp(lp.perUnitWad, 18);
      const unit = lp.numeraire?.symbol ?? copy.risk.liquidationPriceUnitUnknown;
      return risk.healthFactor < WAD
        ? copy.risk.liquidationPricePassed(price, unit, collateralSymbol)
        : copy.risk.liquidationPriceAt(price, unit, collateralSymbol);
    }
  }
}
