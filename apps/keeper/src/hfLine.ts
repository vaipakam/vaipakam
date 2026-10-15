/**
 * apps/keeper — the health-factor line the keeper liquidates below.
 *
 * Its own module so the passes that must agree on it (the liquidator, the
 * grace-default pass, the shared close-out attempt) can all import it
 * without importing each other.
 */

/** A loan whose health factor is below this (1.0, at 1e18 scale) is the
 *  HF liquidator's. */
export const HF_LIQUIDATION_THRESHOLD = 10n ** 18n;
