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

interface Props {
  kind: InterestImplicationKind;
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
export function InterestImplicationWarning({ kind }: Props) {
  const { t } = useTranslation();
  return (
    <div className="alert alert-warning" style={{ display: 'block', marginTop: 12 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 6 }}>
        <AlertTriangle size={18} />
        <strong>{t(TITLE_KEY[kind])}</strong>
      </div>
      <p style={{ margin: 0 }}>{t(BODY_KEY[kind])}</p>
    </div>
  );
}
