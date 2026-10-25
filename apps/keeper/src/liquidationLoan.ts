/**
 * #2733 — the loan fields the liquidator reads, taken from `getLoanDetails` BY
 * NAME and checked for type, so a change to the loan's return shape stops the
 * liquidator from acting on a loan instead of silently feeding it a different
 * field.
 *
 * The partial-liquidation sizer used to read its liquidation threshold from
 * `OracleFacet.getAssetRiskProfile` by POSITION. That getter dropped the
 * per-asset threshold when thresholds moved to per-tier values, so index 3
 * became the liquidation BONUS and the sizer was fed a few hundred bps where it
 * expected a threshold near 8,000. Partials came out mis-sized, the on-chain
 * guards refused them and the keeper escalated towards a full liquidation.
 *
 * The threshold now comes from the loan itself: `liquidationLtvBpsAtInit` is
 * the exact value `RiskFacet.calculateHealthFactor` multiplies the collateral
 * by, stamped at initiation so a later tier change never re-gates the loan. It
 * arrives on the read the liquidator already makes, so the separate oracle read
 * is gone too. `test/liquidationLoan.test.ts` pins every field below to the
 * compiled `getLoanDetails` ABI.
 */
import type { Address } from 'viem';

/** The loan as the liquidator uses it. */
export interface LiquidationLoan {
  collateralAsset: Address;
  collateralAmount: bigint;
  principalAsset: Address;
  /** `LoanStatus`; 0 = Active. */
  status: number;
  /** `AssetType` of the principal; 0 = ERC20. */
  assetType: number;
  startTime: bigint;
  durationDays: bigint;
  /** The liquidation threshold the loan's health factor is computed against,
   *  in bps (`uint16`, so viem decodes it as a number). */
  liquidationLtvBpsAtInit: number;
}

/** Each field's name on the `getLoanDetails` struct, with the JavaScript type
 *  viem decodes its Solidity type to. The test checks this table against the
 *  compiled ABI, so it is the one list to edit when the liquidator needs
 *  another field. */
export const LIQUIDATION_LOAN_FIELDS = {
  collateralAsset: 'address',
  collateralAmount: 'bigint',
  principalAsset: 'address',
  status: 'number',
  assetType: 'number',
  startTime: 'bigint',
  durationDays: 'bigint',
  liquidationLtvBpsAtInit: 'number',
} as const satisfies Record<keyof LiquidationLoan, 'address' | 'bigint' | 'number'>;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Read the liquidator's fields out of a decoded `getLoanDetails` result.
 *  Returns null when any field is missing or decoded to another type: the
 *  struct is not the shape this keeper was built against, and no figure from
 *  it can be trusted. */
export function parseLiquidationLoan(raw: unknown): LiquidationLoan | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  for (const [name, kind] of Object.entries(LIQUIDATION_LOAN_FIELDS)) {
    const v = rec[name];
    const ok =
      kind === 'address'
        ? typeof v === 'string' && ADDRESS.test(v)
        : kind === 'bigint'
          ? typeof v === 'bigint'
          : typeof v === 'number' && Number.isInteger(v);
    if (!ok) return null;
  }
  return {
    collateralAsset: rec.collateralAsset as Address,
    collateralAmount: rec.collateralAmount as bigint,
    principalAsset: rec.principalAsset as Address,
    status: rec.status as number,
    assetType: rec.assetType as number,
    startTime: rec.startTime as bigint,
    durationDays: rec.durationDays as bigint,
    liquidationLtvBpsAtInit: rec.liquidationLtvBpsAtInit as number,
  };
}
