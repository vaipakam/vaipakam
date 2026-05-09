import { Gift, Info, Clock, AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useLoanLenderDiscount } from '../../hooks/useLoanLenderDiscount';
import { useVPFIDiscountConsent } from '../../hooks/useVPFIDiscount';
import { useProtocolConfig } from '../../hooks/useProtocolConfig';
import { L as Link } from '../L';

interface Props {
  loanId: string | null | undefined;
  lender: string | null | undefined;
}

/**
 * Lender-side per-loan widget: shows the **time-weighted** yield-fee
 * discount the lender has earned on this loan so far, plus the tier
 * currently being earned (the "stamped" BPS).
 *
 * The live `effectiveAvgBps` is what the settlement math would use if
 * the borrower repaid right now. It already folds in the open-period
 * contribution client-side, so the user doesn't see a stale number
 * between the on-chain rollups. Rationale: docs/GovernanceConfigDesign.md
 * §5.2a (anti-gaming, time-weighted) + §5.4 (tier-change banner).
 *
 * Hidden entirely when the loan / lender inputs aren't ready yet — no
 * flash-of-empty-card on navigation.
 */
export function LenderDiscountCard({ loanId, lender }: Props) {
  const { t } = useTranslation();
  const loanIdBig = loanId ? safeBigInt(loanId) : null;
  const lenderAddr = typeof lender === 'string' && lender.length > 0
    ? (lender as `0x${string}`)
    : null;

  const { data, isLoading, error } = useLoanLenderDiscount(
    loanIdBig,
    lenderAddr,
  );
  // Platform-level VPFI discount consent for the connected wallet (only
  // rendered to the lender's own viewer per the LoanDetails gate). When
  // consent is off, every loan keeps charging the full treasury cut on
  // yield with no VPFI rebate — surface that explicitly so the user
  // doesn't wonder why the effective tier stays at 0%.
  const { enabled: consentEnabled } = useVPFIDiscountConsent();
  const { config: protocolConfig } = useProtocolConfig();

  if (!loanIdBig || !lenderAddr) return null;
  if (isLoading && !data) return null;
  if (error) return null;
  if (!data) return null;

  const effectivePct = (data.effectiveAvgBps / 100).toFixed(2);
  const stampedPct = (data.stampedBpsAtPreviousRollup / 100).toFixed(2);
  const tiersDiffer =
    data.effectiveAvgBps > 0 &&
    data.stampedBpsAtPreviousRollup > 0 &&
    Math.abs(data.effectiveAvgBps - data.stampedBpsAtPreviousRollup) >= 10; // ≥0.1 pp
  // Banner state. `enabled === null` means we're still loading (or the
  // wallet isn't connected, which can't happen here per the LoanDetails
  // gate but is handled defensively). Showing "missing" while loading
  // would flash the wrong banner on first paint, so we wait.
  const showConsentMissing = consentEnabled === false;
  const showConsentEnabledNoVpfi =
    consentEnabled === true &&
    data.effectiveAvgBps === 0 &&
    data.stampedBpsAtPreviousRollup === 0;
  const treasuryFeePct = protocolConfig
    ? (protocolConfig.treasuryFeeBps / 100).toFixed(
        protocolConfig.treasuryFeeBps % 100 === 0 ? 0 : 2,
      )
    : '1';

  return (
    <div className="card">
      <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Gift size={14} />
        {t('lenderDiscountCard.loanTitle')}
      </div>

      <div className="data-row">
        <span className="data-label">{t('lenderDiscountCard.effectiveSoFar')}</span>
        <span className="data-value">{effectivePct}%</span>
      </div>
      <div className="data-row">
        <span className="data-label">{t('lenderDiscountCard.currentlyEarning')}</span>
        <span className="data-value">{stampedPct}%</span>
      </div>
      <div className="data-row">
        <span className="data-label">
          <Clock size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
          {t('lenderDiscountCard.windowElapsed')}
        </span>
        <span className="data-value">{formatDuration(data.windowSeconds, t)}</span>
      </div>

      {tiersDiffer && (
        <div
          className="alert alert-info"
          style={{ marginTop: 12 }}
          role="status"
        >
          <Info size={14} />
          <div>
            {t('lenderDiscountCard.tiersDifferAlertPrefix')}
            <strong>{effectivePct}%</strong>
            {t('lenderDiscountCard.tiersDifferAlertMid')}
            <strong>{stampedPct}%</strong>
            {t('lenderDiscountCard.tiersDifferAlertSuffix')}
          </div>
        </div>
      )}

      {showConsentMissing && (
        <div
          className="alert alert-warning"
          style={{ marginTop: 12 }}
          role="status"
        >
          <AlertTriangle size={14} />
          <div>
            <strong>{t('lenderDiscountCard.consentMissingTitle')}</strong>
            <br />
            {t('lenderDiscountCard.consentMissingBody', {
              treasuryFee: treasuryFeePct,
            })}{' '}
            <Link
              to="/app"
              style={{ color: 'var(--brand)', textDecoration: 'underline' }}
            >
              {t('lenderDiscountCard.consentMissingCta')}
            </Link>
          </div>
        </div>
      )}

      {showConsentEnabledNoVpfi && (
        <div
          className="alert alert-info"
          style={{ marginTop: 12 }}
          role="status"
        >
          <Info size={14} />
          <div>
            <strong>{t('lenderDiscountCard.consentEnabledNoVpfiTitle')}</strong>
            <br />
            {t('lenderDiscountCard.consentEnabledNoVpfiBody')}
          </div>
        </div>
      )}
    </div>
  );
}

/** Safe BigInt cast that shrugs off obvious garbage input rather than throwing. */
function safeBigInt(s: string): bigint | null {
  if (!/^\d+$/.test(s)) return null;
  try {
    return BigInt(s);
  } catch {
    return null;
  }
}

function formatDuration(seconds: number, t: TFunction): string {
  if (seconds <= 0) return t('lenderDiscountCard.duration0s');
  const days = Math.floor(seconds / 86_400);
  if (days >= 1) {
    const hours = Math.floor((seconds % 86_400) / 3_600);
    return hours > 0
      ? t('lenderDiscountCard.durationDaysHours', { days, hours })
      : t('lenderDiscountCard.durationDays', { days });
  }
  const hours = Math.floor(seconds / 3_600);
  if (hours >= 1) {
    const mins = Math.floor((seconds % 3_600) / 60);
    return mins > 0
      ? t('lenderDiscountCard.durationHoursMins', { hours, mins })
      : t('lenderDiscountCard.durationHours', { hours });
  }
  const mins = Math.floor(seconds / 60);
  return mins >= 1
    ? t('lenderDiscountCard.durationMins', { mins })
    : t('lenderDiscountCard.durationSecs', { seconds });
}
