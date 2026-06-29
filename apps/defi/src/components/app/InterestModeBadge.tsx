import { useTranslation } from 'react-i18next';

interface Props {
  /**
   * The offer/loan's interest mode. `true` = full-term (borrower owes interest
   * for the whole term even on early repay), `false` = pro-rata (interest only
   * for the elapsed period). `undefined` ⇒ the distinction does not apply
   * (e.g. non-ERC-20 principal) ⇒ render nothing so we never imply a mode that
   * isn't meaningful for the asset class.
   */
  fullTermInterest?: boolean;
  /**
   * When the offer allows partial repayments, full-term still lets early
   * principal paydown reduce future interest on the reduced balance — this
   * refines the tooltip so the chip doesn't overstate the full-term penalty
   * (the same nuance RiskDisclosures draws). Ignored for pro-rata.
   */
  allowsPartialRepay?: boolean;
  /** Compact sizing for dense table cells (e.g. the Offer Book rows). */
  compact?: boolean;
}

/**
 * #797 — a small, consistent chip that surfaces whether a loan/offer charges
 * FULL-TERM or PRO-RATA interest, so the borrower-expectation risk (early
 * repayment may still owe full-term interest) is visible wherever a position's
 * economics are shown — Offer Book rows, Loan Details, and the borrower exit
 * surfaces (preclose / swap-to-repay). The detailed consequences live in
 * RiskDisclosures + the Advanced guide; this is the at-a-glance signal.
 *
 * Colour follows the shared `status-badge` palette: full-term uses the
 * `defaulted` (cautionary) tone because it's the higher-cost-on-early-exit
 * case, pro-rata uses the `active` (benign) tone. The tooltip carries the
 * one-line explanation for hover/focus.
 */
export function InterestModeBadge({
  fullTermInterest,
  allowsPartialRepay,
  compact,
}: Props) {
  const { t } = useTranslation();
  if (fullTermInterest === undefined) return null;

  const isFullTerm = fullTermInterest === true;
  const label = isFullTerm
    ? t('interestMode.fullTerm')
    : t('interestMode.proRata');
  const tip = isFullTerm
    ? allowsPartialRepay
      ? t('interestMode.fullTermPartialTip')
      : t('interestMode.fullTermTip')
    : t('interestMode.proRataTip');

  return (
    <span
      className={`status-badge ${isFullTerm ? 'defaulted' : 'active'}`}
      title={tip}
      style={compact ? { fontSize: '0.68rem', padding: '2px 7px' } : undefined}
    >
      {label}
    </span>
  );
}
