/**
 * A loan's risk reads as ONE aggregate — the plan that builds it and the
 * mapper that reads it back. Pure: no wagmi, no query, no chain, so both
 * halves are tested without either (the same shape as `forcedCloseReads`).
 *
 * ## Why an aggregate
 *
 * The liquidation price (#2531) is the collateral's current price divided by
 * the health factor, so the two have to come from the SAME block: a price
 * read a block after the health factor describes a line the loan never had.
 * Multicall3's `aggregate3` evaluates every call in one execution, and with
 * `allowFailure` each slot keeps its own status, so a revert in one read
 * stays that read's answer.
 *
 * That last property is also what lets the aggregate tell an on-chain
 * revert from a provider failure without inspecting error classes: a slot
 * that reports `failure` is the chain refusing that call, while a provider
 * failure fails the whole aggregate and surfaces as a query error.
 *
 * ## Why the liquidation price is derived, not asked
 *
 * `RiskFacet.calculateHealthFactor` is the collateral's numeraire value times
 * the loan's liquidation threshold, over the numeraire value of what is owed.
 * With the amount owed and the borrowed asset's price held where they are,
 * it is therefore proportional to the collateral's price, and reaches 1.00 at
 * the current price divided by the health factor. Deriving it from the
 * contract's own two answers keeps one rule — the contract's — rather than a
 * second copy of the threshold, the interest accrual and the valuation in the
 * app.
 */
import { DIAMOND_ABI_VIEM } from '../contracts/diamond';
import { numeraireOf, type Numeraire } from './numeraire';

const WAD = 10n ** 18n;
const MAX_UINT256 = 2n ** 256n - 1n;

export type LoanRiskReadKey = 'hf' | 'ltv' | 'unitValue' | 'numeraire';

/** One call in the aggregate, in the loose shape viem's `multicall` takes. */
export interface LoanRiskReadEntry {
  key: LoanRiskReadKey;
  contract: {
    address: `0x${string}`;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  };
}

/** What `multicall({ allowFailure: true })` hands back, per call. */
export interface MulticallSlot {
  status: 'success' | 'failure';
  result?: unknown;
  error?: unknown;
}

/** The ERC-20 collateral the liquidation price is asked about. */
export interface RiskCollateral {
  asset: `0x${string}`;
  /** The token's own `decimals()`, so one WHOLE unit can be valued. */
  decimals: number;
}

/** Where the health factor reaches 1.00, as far as the app can say.
 *
 *  - `priced`: the collateral price, in the numeraire per whole collateral
 *    token, 1e18-scaled, at which the health factor reaches 1.00 with the
 *    amount owed and the borrowed asset's price as they were at the read.
 *    Rounded UP, so the figure is never below the real line: a borrower
 *    reading it is never told they have more room than they do.
 *  - `none`: the health factor saturated (nothing owed, or a debt too small
 *    against the collateral to register), so no collateral price brings the
 *    loan to the line at today's amount owed.
 *  - `unknown`: the health factor answered but the collateral's price did
 *    not, or answered zero. A price the app cannot substantiate is not
 *    shown, and never as zero. */
export type LiquidationPrice =
  | { kind: 'priced'; perUnitWad: bigint; numeraire: Numeraire | null }
  | { kind: 'none' }
  | { kind: 'unknown' };

export interface LoanRisk {
  /** False when the health-factor or LTV read reverted → illiquid legs,
   *  no automatic liquidation applies. */
  priced: boolean;
  healthFactor: bigint;
  ltv: bigint;
  /** Present only when the caller asked about a collateral and the loan is
   *  priced; see `LiquidationPrice`. */
  liquidationPrice?: LiquidationPrice;
}

/**
 * The calls, in the order the mapper reads them back. The collateral pair
 * (`unitValue`, `numeraire`) is present only when the caller asked for the
 * liquidation price: list rows read the health factor alone, and pay for
 * nothing they do not render.
 *
 * `unitValue` asks `getNumeraireValue(asset, oneWholeUnit, false)` — the
 * collateral leg's own valuation rule (rounding down), the one the health
 * factor's collateral side is computed with.
 */
export function loanRiskReadPlan(input: {
  diamond: `0x${string}`;
  loanId: bigint;
  collateral?: RiskCollateral;
}): LoanRiskReadEntry[] {
  const d = { address: input.diamond, abi: DIAMOND_ABI_VIEM } as const;
  const plan: LoanRiskReadEntry[] = [
    { key: 'hf', contract: { ...d, functionName: 'calculateHealthFactor', args: [input.loanId] } },
    { key: 'ltv', contract: { ...d, functionName: 'calculateLTV', args: [input.loanId] } },
  ];
  if (input.collateral !== undefined) {
    plan.push(
      {
        key: 'unitValue',
        contract: {
          ...d,
          functionName: 'getNumeraireValue',
          args: [input.collateral.asset, 10n ** BigInt(input.collateral.decimals), false],
        },
      },
      { key: 'numeraire', contract: { ...d, functionName: 'getNumeraireSymbol' } },
    );
  }
  return plan;
}

/**
 * Read the aggregate back. A slot count that does not match the plan is a
 * programming error and is thrown rather than zipped by position.
 *
 * Either risk read failing is the protocol saying the loan is not priced —
 * `priced: false`, as before the aggregate. The collateral pair never
 * affects that verdict; it only decides what the liquidation price says.
 */
export function loanRiskFromSlots(
  plan: readonly LoanRiskReadEntry[],
  slots: readonly MulticallSlot[],
): LoanRisk {
  if (slots.length !== plan.length) {
    throw new Error(`loan-risk aggregate returned ${slots.length} slot(s) for a plan of ${plan.length}`);
  }
  const ok = new Map<LoanRiskReadKey, unknown>();
  plan.forEach((entry, i) => {
    if (slots[i].status === 'success') ok.set(entry.key, slots[i].result);
  });

  const hf = ok.get('hf');
  const ltv = ok.get('ltv');
  if (typeof hf !== 'bigint' || typeof ltv !== 'bigint') {
    return { priced: false, healthFactor: 0n, ltv: 0n };
  }
  const risk: LoanRisk = { priced: true, healthFactor: hf, ltv };
  if (plan.some((e) => e.key === 'unitValue')) {
    risk.liquidationPrice = liquidationPriceOf(hf, ok.get('unitValue'), ok.get('numeraire'));
  }
  return risk;
}

/** `unitValue / hf`, in WAD, rounded up — see `LiquidationPrice`. */
export function liquidationPriceOf(
  healthFactor: bigint,
  unitValue: unknown,
  numeraireWord: unknown,
): LiquidationPrice {
  if (healthFactor === MAX_UINT256) return { kind: 'none' };
  if (typeof unitValue !== 'bigint' || unitValue === 0n || healthFactor === 0n) {
    return { kind: 'unknown' };
  }
  const perUnitWad = (unitValue * WAD + healthFactor - 1n) / healthFactor;
  return {
    kind: 'priced',
    perUnitWad,
    numeraire: typeof numeraireWord === 'string' ? numeraireOf(numeraireWord) : null,
  };
}
