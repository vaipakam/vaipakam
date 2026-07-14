/**
 * T-092 #511 sub (#522) — error → i18n translation key mapping for
 * the auto-lifecycle surface (AutoLifecycleFacet + RefinanceFacet
 * + LibAutoRefinanceCheck + OfferCreateFacet refinance-tagged path).
 *
 * The dapp's existing error display sites use raw `err.message`,
 * which surfaces a Solidity selector or revert-string to the user
 * (often unreadable: "Error: AutoRefinanceCapsRequired()" or the
 * underlying RPC error wrapper). This module maps the selector
 * names to the `autoLifecycle.errors.*` translation keys added to
 * `apps/defi/src/i18n/locales/*.json`.
 *
 * Usage:
 *
 *   const key = decodeAutoLifecycleError(err);
 *   const message = key ? t(key) : (err as Error).message;
 *
 * If the error doesn't match a known auto-lifecycle selector, the
 * function returns `null` so the caller falls back to its existing
 * error-display path.
 */

/** Known auto-lifecycle revert selector names — exactly the
 *  Solidity error names declared on the relevant facets +
 *  libraries. Order doesn't matter; matching is by substring on
 *  the error message. */
const SELECTORS = [
  // AutoLifecycleFacet
  'AutoLendDisabled',
  'AutoRefinanceDisabled',
  'AutoExtendDisabled',
  'BothSideAutoExtendRequired',
  'AutoExtendRateOutOfBand',
  'AutoExtendExpiryExceedsCap',
  'AutoExtendDurationOutOfRange',
  'AutoExtendTooSoonAfterStart',
  'AutoExtendEndTimeOverflow',
  'ExtensionGraceExpired',
  'ExtensionMustExtend',
  'InvalidCaps',
  'LoanNotActive',
  'UnsupportedAssetTypeForExtend',
  'PeriodicCadenceMustSettleFirst',
  // LibAutoRefinanceCheck
  'RefinanceTargetNotActive',
  'RefinanceTargetNotBorrower',
  'RefinanceCapsRequired',
  'RefinanceRateExceedsCap',
  'RefinanceExpiryExceedsCap',
  'RefinanceTargetIncompatible',
  'RefinanceTargetPastGrace',
  // OfferCreateFacet refinance-tagged path
  'InvalidRefinanceTarget',
  // #625 WI-1 — auto-lend intent + keeper-delegation surface
  // (LenderIntentFacet / ProfileFacet keeper grants). Listed before the
  // shorter generic names so the more specific intent names match first.
  'LenderIntentInvalidBounds',
  'LenderIntentSelfCollateralized',
  'LenderIntentVpfiLendingUnsupported',
  'LenderIntentZeroAddress',
  'LenderIntentNotActive',
  'IntentCapitalInsufficient',
  'RiskAndTermsConsentRequired',
  'InvalidKeeperActions',
  'KeeperAlreadyApproved',
  'KeeperNotApproved',
  'KeeperWhitelistFull',
  'SanctionedAddress',
] as const;

export type AutoLifecycleErrorName = (typeof SELECTORS)[number];

/**
 * Returns the i18n key for a recognised auto-lifecycle revert,
 * or `null` when the error doesn't match. Matches on substring,
 * not the 4-byte selector — Solidity error names appear in the
 * revert wrapper's message in plain text on every dapp toolchain
 * we ship against (viem, wagmi, ethers).
 */
export function decodeAutoLifecycleError(err: unknown): string | null {
  if (!err) return null;
  const message =
    (err as { shortMessage?: string }).shortMessage ??
    (err as { message?: string }).message ??
    String(err);
  for (const name of SELECTORS) {
    if (message.includes(name)) {
      return `autoLifecycle.errors.${name}`;
    }
  }
  return null;
}

/**
 * Convenience hook-like helper that returns the localised message
 * if recognised, or the original error message as the fallback.
 *
 * Usage at the call site:
 *
 *   const message = autoLifecycleErrorOrRaw(err, t);
 *   setError(message);
 */
export function autoLifecycleErrorOrRaw(
  err: unknown,
  t: (key: string) => string,
): string {
  const key = decodeAutoLifecycleError(err);
  if (key) return t(key);
  return (err as { shortMessage?: string }).shortMessage ??
    (err as { message?: string }).message ??
    String(err);
}
