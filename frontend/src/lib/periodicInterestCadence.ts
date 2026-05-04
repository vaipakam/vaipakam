/**
 * T-034 — Periodic Interest Payment cadence helpers (frontend mirror of
 * the contract's enum + validation matrix). Keep in lockstep with
 *
 *   - `LibVaipakam.PeriodicInterestCadence` enum
 *   - `LibVaipakam.intervalDays` lookup
 *   - `OfferFacet._validatePeriodicCadence` Filter 0 / 1 / 2 logic
 *
 * Drift between this module and the contract = creates an offer with a
 * cadence the contract will revert on ⇒ bad UX. Update both sides
 * together. See docs/DesignsAndPlans/PeriodicInterestPaymentDesign.md.
 */
/** Mirrors the on-chain `LibVaipakam.LiquidityStatus` enum.
 *  0 = Liquid, 1 = Illiquid. */
export type LiquidityStatus = 0 | 1;
/** Mirrors `LibVaipakam.AssetType`. 0 = ERC20, 1 = ERC721, 2 = ERC1155. */
export type AssetTypeEnum = 0 | 1 | 2;

/** Numeric value matches the on-chain enum. Order matters. Uses the
 *  `const` object pattern (vs TS `enum`) per the project's
 *  `erasableSyntaxOnly` tsconfig — same shape as `AssetType` in
 *  `types/loan.ts`. */
export const PeriodicInterestCadence = {
  None: 0,
  Monthly: 1,
  Quarterly: 2,
  SemiAnnual: 3,
  Annual: 4,
} as const;
export type PeriodicInterestCadence =
  (typeof PeriodicInterestCadence)[keyof typeof PeriodicInterestCadence];

/** Display label per cadence — i18n key, NOT the literal string. The
 *  English fallback lives in the locale file under
 *  `periodicInterest.cadence.<value>`. */
export const CADENCE_I18N_KEY: Record<PeriodicInterestCadence, string> = {
  [PeriodicInterestCadence.None]: 'periodicInterest.cadence.none',
  [PeriodicInterestCadence.Monthly]: 'periodicInterest.cadence.monthly',
  [PeriodicInterestCadence.Quarterly]: 'periodicInterest.cadence.quarterly',
  [PeriodicInterestCadence.SemiAnnual]: 'periodicInterest.cadence.semiAnnual',
  [PeriodicInterestCadence.Annual]: 'periodicInterest.cadence.annual',
};

/** Interval-in-days lookup. Mirrors `LibVaipakam.intervalDays`. */
export function intervalDays(cadence: PeriodicInterestCadence): number {
  switch (cadence) {
    case PeriodicInterestCadence.Monthly:
      return 30;
    case PeriodicInterestCadence.Quarterly:
      return 90;
    case PeriodicInterestCadence.SemiAnnual:
      return 180;
    case PeriodicInterestCadence.Annual:
      return 365;
    default:
      return 0;
  }
}

/** Map cadence → grace-bucket index in the T-044 6-slot table. Used by
 *  the CreateOffer info copy ("missed payment grace = X days") and by
 *  PR2/PR3 settlement-preview UI. The mapping comes from §1.1 of the
 *  design doc — Monthly→slot 1, Quarterly→slot 2, SemiAnnual→slot 3,
 *  Annual→slot 4. */
export function graceSlotIndex(cadence: PeriodicInterestCadence): number {
  switch (cadence) {
    case PeriodicInterestCadence.Monthly:
      return 1;
    case PeriodicInterestCadence.Quarterly:
      return 2;
    case PeriodicInterestCadence.SemiAnnual:
      return 3;
    case PeriodicInterestCadence.Annual:
      return 4;
    default:
      return -1;
  }
}

/** Inputs for the validation matrix — matches what `createOffer` knows
 *  at submission time. */
export interface CadenceValidationInput {
  cadence: PeriodicInterestCadence;
  durationDays: number;
  /** Both sides liquid? Computed from each leg's `LiquidityStatus`. */
  bothLiquid: boolean;
  /** Principal expressed in numeraire-units (1e18-scaled), as the
   *  protocol would see it after the on-chain oracle conversion. The
   *  frontend reuses the same conversion pipeline in `useOfferQuote`
   *  / `useNumeraireValue` and passes the result here. */
  principalNumeraire1e18: bigint;
  /** Effective `minPrincipalForFinerCadence` (after the zero-fallback
   *  resolves to the library default). 1e18-scaled, in numeraire-units. */
  threshold1e18: bigint;
  /** Master kill-switch state. */
  periodicInterestEnabled: boolean;
}

export type CadenceRejection =
  | 'periodic-disabled'
  | 'illiquid-leg'
  | 'interval-not-less-than-duration'
  | 'multi-year-requires-annual-floor'
  | 'multi-year-finer-than-annual-needs-threshold'
  | 'short-duration-cadence-needs-threshold';

/** Pure-function port of the contract's `_validatePeriodicCadence`.
 *  Returns `null` if the cadence is allowed, or the rejection code so
 *  the UI can render a precise error. The dropdown filter uses this in
 *  a loop to compute which options are reachable. */
export function validateCadence(
  input: CadenceValidationInput,
): CadenceRejection | null {
  const {
    cadence,
    durationDays,
    bothLiquid,
    principalNumeraire1e18,
    threshold1e18,
    periodicInterestEnabled,
  } = input;

  // Master kill-switch first — when off, only None is reachable.
  if (cadence !== PeriodicInterestCadence.None && !periodicInterestEnabled) {
    return 'periodic-disabled';
  }

  // Filter 0 — both sides must be liquid for any non-None cadence.
  if (cadence !== PeriodicInterestCadence.None && !bothLiquid) {
    return 'illiquid-leg';
  }

  const isMultiYear = durationDays > 365;
  const aboveThreshold = principalNumeraire1e18 >= threshold1e18;

  // Multi-year mandatory floor: cadence MUST be at least Annual.
  if (isMultiYear) {
    if (cadence === PeriodicInterestCadence.None) {
      return 'multi-year-requires-annual-floor';
    }
    if (!aboveThreshold && cadence !== PeriodicInterestCadence.Annual) {
      return 'multi-year-finer-than-annual-needs-threshold';
    }
  } else {
    // ≤365d. Below threshold → only None allowed.
    if (cadence !== PeriodicInterestCadence.None && !aboveThreshold) {
      return 'short-duration-cadence-needs-threshold';
    }
  }

  // Filter 1 — interval strictly less than duration. Skip when None.
  if (cadence !== PeriodicInterestCadence.None) {
    const interval = intervalDays(cadence);
    if (interval >= durationDays) {
      return 'interval-not-less-than-duration';
    }
  }

  return null;
}

/** Convenience wrapper: which cadences pass the matrix for the given
 *  context? Returns the array in display order. The dropdown calls this
 *  to derive which options to render. Returning `[]` means the entire
 *  cadence section should be hidden (matches Filter 0's "no UI element"
 *  rule when either side is illiquid). */
export function allowedCadences(
  base: Omit<CadenceValidationInput, 'cadence'>,
): PeriodicInterestCadence[] {
  // Filter 0 — illiquid → cadence section completely hidden.
  if (!base.bothLiquid) return [];

  const all: PeriodicInterestCadence[] = [
    PeriodicInterestCadence.None,
    PeriodicInterestCadence.Monthly,
    PeriodicInterestCadence.Quarterly,
    PeriodicInterestCadence.SemiAnnual,
    PeriodicInterestCadence.Annual,
  ];
  return all.filter((c) => validateCadence({ ...base, cadence: c }) === null);
}

/** Auto-select rule for the dropdown's initial value: pick the lowest
 *  allowed cadence. For multi-year loans that's `Annual` (the mandatory
 *  floor); for short-duration loans that's `None`. The lender can
 *  change away from the auto-selected value within the allowed set. */
export function defaultCadence(
  base: Omit<CadenceValidationInput, 'cadence'>,
): PeriodicInterestCadence {
  const allowed = allowedCadences(base);
  if (allowed.length === 0) return PeriodicInterestCadence.None;
  return allowed[0];
}

/** Helper for the CreateOffer form: compute `bothLiquid` from each
 *  leg's classification. NFT lending / NFT collateral always force
 *  cadence to None (Filter 0), independent of the principal/collateral
 *  tokens' DEX coverage. */
export function bothLegsLiquid(
  principalLiquidity: LiquidityStatus | null,
  collateralLiquidity: LiquidityStatus | null,
  principalAssetType: AssetTypeEnum,
  collateralAssetType: AssetTypeEnum,
): boolean {
  if (principalLiquidity == null || collateralLiquidity == null) return false;
  // 0 = Liquid, 1 = Illiquid in the on-chain enum. Match enum values
  // verbatim so a contract change here would cause a TS-side compile
  // error if `LiquidityStatus` shifts.
  if (principalLiquidity !== 0 || collateralLiquidity !== 0) return false;
  // 0 = ERC20 in the on-chain enum. NFT lending / NFT collateral fall
  // into Filter 0's illiquid branch even when the underlying contracts
  // happen to have an oracle.
  if (principalAssetType !== 0 || collateralAssetType !== 0) return false;
  return true;
}
