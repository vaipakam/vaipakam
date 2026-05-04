import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  PeriodicInterestCadence,
  CADENCE_I18N_KEY,
  intervalDays,
  bothLegsLiquid,
  validateCadence,
  defaultCadence,
  type AssetTypeEnum,
  type LiquidityStatus,
} from '../../lib/periodicInterestCadence';

interface Props {
  /** Numeric cadence value the user has selected. 0 = None. */
  value: number;
  onChange: (next: number) => void;

  // Inputs needed for the validation matrix. Match the shape of
  // `CreateOfferParams` after assetType/liquidity classification.
  durationDays: number;
  principalLiquidity: LiquidityStatus | null;
  collateralLiquidity: LiquidityStatus | null;
  principalAssetType: AssetTypeEnum;
  collateralAssetType: AssetTypeEnum;

  /** Master kill-switch state from `usePeriodicInterestConfig`. */
  periodicInterestEnabled: boolean;
  /** Threshold in numeraire-units (1e18-scaled). */
  threshold1e18: bigint;
}

/**
 * T-034 — cadence dropdown for the Advanced section of CreateOffer.
 *
 * Hidden entirely when:
 *   - master kill-switch is off, OR
 *   - either leg is illiquid (Filter 0 — design doc §3.0).
 *
 * Visible options are filtered by Filter 1 (interval < duration) and
 * the multi-year mandatory floor. Filter 2's principal-threshold gate
 * is NOT enforced client-side — it requires live oracle pricing of the
 * principal in numeraire-units, which is the contract's job. The
 * dropdown surfaces a hint about the threshold in numeraire-units so
 * the lender can self-judge; if they submit a non-qualifying cadence
 * the contract reverts `CadenceNotAllowed` and the decoder surfaces it.
 */
export function PeriodicInterestCadenceField({
  value,
  onChange,
  durationDays,
  principalLiquidity,
  collateralLiquidity,
  principalAssetType,
  collateralAssetType,
  periodicInterestEnabled,
  threshold1e18,
}: Props) {
  const { t } = useTranslation();

  const liquid = bothLegsLiquid(
    principalLiquidity,
    collateralLiquidity,
    principalAssetType,
    collateralAssetType,
  );

  // Filter 0 — illiquid: render NOTHING. Per the design doc §3.0, even
  // a disabled control is wrong here — the feature should look like it
  // doesn't exist for illiquid offers.
  if (!liquid) return null;
  // Master kill-switch off — same "feature doesn't exist" rule.
  if (!periodicInterestEnabled) return null;

  // Compute the visible options. We deliberately bypass the
  // principal-threshold component of Filter 2 here (no live oracle
  // pricing in the dropdown) — the contract is the authoritative gate.
  // The hint copy below explains the threshold.
  const options = useMemo<{ value: number; label: string; disabled?: boolean; reason?: string }[]>(() => {
    const all: PeriodicInterestCadence[] = [
      PeriodicInterestCadence.None,
      PeriodicInterestCadence.Monthly,
      PeriodicInterestCadence.Quarterly,
      PeriodicInterestCadence.SemiAnnual,
      PeriodicInterestCadence.Annual,
    ];
    return all.map((c) => {
      // For the dropdown filter, treat principal as IF-above-threshold so
      // we only filter on Filter 0 / 1 + multi-year-floor. The lender is
      // implicitly responsible for picking a cadence their principal
      // qualifies for — the contract enforces the rest.
      const rejection = validateCadence({
        cadence: c,
        durationDays,
        bothLiquid: liquid,
        principalNumeraire1e18: 1n << 200n, // synthetic "very large"
        threshold1e18,
        periodicInterestEnabled,
      });
      return {
        value: c,
        label: t(CADENCE_I18N_KEY[c]),
        disabled: rejection !== null,
        reason: rejection ?? undefined,
      };
    });
  }, [durationDays, liquid, threshold1e18, periodicInterestEnabled, t]);

  // Multi-year loans force `Annual` as the floor — auto-select if the
  // user is currently sitting on an invalid value.
  const fallbackValue = useMemo(
    () =>
      defaultCadence({
        durationDays,
        bothLiquid: liquid,
        principalNumeraire1e18: 1n << 200n,
        threshold1e18,
        periodicInterestEnabled,
      }),
    [durationDays, liquid, threshold1e18, periodicInterestEnabled],
  );

  const currentDisabled = options.find((o) => o.value === value)?.disabled ?? false;
  const effectiveValue = currentDisabled ? fallbackValue : value;

  return (
    <div style={{ marginTop: 12 }}>
      <label style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>
        {t('createOffer.periodicInterest.label')}
      </label>
      <select
        value={effectiveValue}
        onChange={(e) => onChange(parseInt(e.target.value, 10))}
        style={{ width: '100%', padding: 8 }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
            {o.value !== PeriodicInterestCadence.None
              ? ` (${intervalDays(o.value as PeriodicInterestCadence)}d)`
              : ''}
            {o.disabled && o.reason === 'interval-not-less-than-duration'
              ? ` — ${t('createOffer.periodicInterest.disabledShort')}`
              : ''}
          </option>
        ))}
      </select>
      <small style={{ display: 'block', opacity: 0.75, marginTop: 4 }}>
        {durationDays > 365
          ? t('createOffer.periodicInterest.hintMultiYear')
          : t('createOffer.periodicInterest.hintShort')}
      </small>
    </div>
  );
}
