import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export type InterestImplicationKind =
  | 'early-withdrawal'
  | 'preclose-direct'
  | 'preclose-transfer'
  | 'preclose-offset'
  | 'refinance';

const TITLE_KEY: Record<InterestImplicationKind, string> = {
  'early-withdrawal': 'interestWarning.earlyWithdrawalTitle',
  'preclose-direct': 'interestWarning.precloseDirectTitle',
  'preclose-transfer': 'interestWarning.precloseTransferTitle',
  'preclose-offset': 'interestWarning.precloseOffsetTitle',
  refinance: 'interestWarning.refinanceTitle',
};

const BODY_KEY: Record<InterestImplicationKind, string> = {
  'early-withdrawal': 'interestWarning.earlyWithdrawalBody',
  'preclose-direct': 'interestWarning.precloseDirectBody',
  'preclose-transfer': 'interestWarning.precloseTransferBody',
  'preclose-offset': 'interestWarning.precloseOffsetBody',
  refinance: 'interestWarning.refinanceBody',
};

// #797 — the Direct-preclose and Refinance payouts settle the OLD loan at its
// own interest mode: a full-term loan owes interest as if it ran to maturity,
// but a pro-rata loan owes only interest accrued to date. The default copy
// (above) describes the full-term case; when the loan is known to be pro-rata
// we swap in a pro-rata-specific title/body so the warning never overstates
// the cost of exiting a pro-rata loan. Kinds whose copy isn't full-term-
// specific (early-withdrawal / transfer / offset) have no pro-rata variant.
const PRORATA_TITLE_KEY: Partial<Record<InterestImplicationKind, string>> = {
  'preclose-direct': 'interestWarning.precloseDirectTitleProRata',
  refinance: 'interestWarning.refinanceTitleProRata',
};

const PRORATA_BODY_KEY: Partial<Record<InterestImplicationKind, string>> = {
  'preclose-direct': 'interestWarning.precloseDirectBodyProRata',
  refinance: 'interestWarning.refinanceBodyProRata',
};

interface Props {
  kind: InterestImplicationKind;
  /**
   * #797 — the affected loan's interest mode. `false` (pro-rata) selects the
   * pro-rata copy for the full-term-specific kinds; `true`/`undefined` keeps
   * the default full-term copy (the conservative, higher-cost disclosure).
   */
  fullTermInterest?: boolean;
}

/**
 * Pre-confirm callout that surfaces the interest-side cost of a strategic
 * exit flow before the user signs:
 *
 *   - Early Withdrawal forfeits accrued interest to treasury (or applies it
 *     toward a rate shortfall to the new lender) — the original lender does
 *     NOT walk away with their accrued earnings.
 *   - Preclose Direct charges the borrower FULL-TERM interest, not pro-rata.
 *   - Preclose Transfer / Offset charges accrued interest + a rate shortfall
 *     to compensate the lender for any rate drop on the new terms.
 *   - Refinance repays the old lender with FULL-TERM interest + shortfall.
 *
 * Caller renders this above the confirm button in each flow's review step.
 * Same `alert alert-warning` chrome as `<TransferLockWarning>` so the visual
 * language stays consistent across pre-confirm callouts.
 */
export function InterestImplicationWarning({ kind, fullTermInterest }: Props) {
  const { t } = useTranslation();
  const proRata = fullTermInterest === false;
  const titleKey =
    (proRata && PRORATA_TITLE_KEY[kind]) || TITLE_KEY[kind];
  const bodyKey = (proRata && PRORATA_BODY_KEY[kind]) || BODY_KEY[kind];
  return (
    <div className="alert alert-warning" style={{ display: 'block', marginTop: 12 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 6 }}>
        <AlertTriangle size={18} />
        <strong>{t(titleKey)}</strong>
      </div>
      <p style={{ margin: 0 }}>{t(bodyKey)}</p>
    </div>
  );
}
