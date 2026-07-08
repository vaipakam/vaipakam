import type { SimResult } from '../contracts/useTxSimulation';

/**
 * Under-collateral revert filter for the borrow terms-step precheck (#1112).
 *
 * The precheck runs the prospective `createOffer` calldata as a read-only
 * `eth_call` and warns ONLY when the revert means the borrow is
 * under-collateralised — the collateral is too low for the requested amount,
 * or the loan would breach the LTV cap / minimum health factor. Every other
 * revert (self-trade, duration cap, an incomplete form) stays silent here so
 * the terms step doesn't cry wolf; the review-step SimulationPreview still
 * surfaces those before signing.
 *
 * Keyed on the DECODED error NAME (not the 4-byte selector) so a Solidity-side
 * param-type change can't silently desync the set — the #68 drift guard keeps
 * the name↔selector map honest, and `useTxSimulation` already decodes the name.
 */
export const UNDER_COLLATERAL_ERROR_NAMES: ReadonlySet<string> = new Set([
  'MaxLendingAboveCeiling', // collateral too low for the requested lending amount
  'MinCollateralBelowFloor', // collateral below the minimum its size needs
  'InitLtvAboveTier', // borrow would exceed the risk tier's LTV cap
  'LTVExceeded', // loan-to-value ratio too high
  'HealthFactorTooLow', // would open below the minimum health factor
  'MatchHFTooLow', // match would leave HF below the floor
  'ZeroCollateral', // no collateral locked at all
]);

/**
 * True when a pre-sign simulation reverted specifically because the borrow is
 * under-collateralised. The only case the terms-step precheck banner renders.
 */
export function isUnderCollateralRevert(result: SimResult): boolean {
  return (
    result.status === 'revert' &&
    result.revertName != null &&
    UNDER_COLLATERAL_ERROR_NAMES.has(result.revertName)
  );
}
