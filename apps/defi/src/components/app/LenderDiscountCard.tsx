import { Gift, Info, Clock, AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useLoanLenderDiscount } from '../../hooks/useLoanLenderDiscount';
import { useVPFIDiscountConsentFor, useVPFIDiscountTier } from '../../hooks/useVPFIDiscount';
import { useProtocolConfig } from '../../hooks/useProtocolConfig';
import { useReadChain } from '../../contracts/useDiamond';
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
  // T-087 Sub 4 round-3 P2 #3 — read consent for the LENDER, not the
  // connected wallet. After a position NFT transfer, the holder and
  // the loan's lender may differ; keying the banner on the holder's
  // consent surfaces the wrong promise. The lender is the principal
  // for the discount accumulator.
  const { enabled: consentEnabled } = useVPFIDiscountConsentFor(lenderAddr);
  const { config: protocolConfig } = useProtocolConfig();
  // T-087 Sub 4 — read the lender's vault balance + effective tier
  // so we can distinguish the two reasons the discount might be 0:
  //   (a) the lender has NO VPFI staked at all → "stake some VPFI" CTA.
  //   (b) the lender HAS VPFI but is still in the min-history window
  //       → "your tier will activate soon" CTA + the poke button.
  const { data: discountTierData } = useVPFIDiscountTier(lenderAddr);
  const chain = useReadChain();

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
  // T-087 Sub 4 round-1 P2 #1 — use the RAW tier (balance-based,
  // pre-min-history gate) as the qualifying signal for "min-history
  // pending". `rawTier > 0` means the balance is at-or-above a tier
  // threshold; the effective tier being 0 then says "the time gate
  // hasn't released yet, but it will." For sub-tier balances
  // (e.g. dust below the Tier-1 floor), rawTier is 0 too, so we
  // correctly fall back to the "no eligible VPFI" copy.
  //
  // T-087 Sub 4 round-1 P2 #3 — gate by isCanonicalVPFI. On a
  // mirror chain `getEffectiveDiscount` returns 0 not only during
  // the min-history window but also when the cached tier slot is
  // missing/expired/at-the-wrong-version. The signal is unambiguous
  // only on the canonical chain; on mirrors we fall back to the
  // generic "no eligible VPFI" copy so we don't promise an
  // automatic activation that may never come.
  const isCanonical = chain.isCanonicalVPFI === true;
  // T-087 Sub 4 round-3 P2 #1 — the load-bearing signal is the TRACKED
  // tier (`tierOf(trackedBal)`). A user with a tiny legitimate
  // tracked stake + a large direct-transfer dust would have
  // `rawTier > 0 && trackedBal > 0` but `trackedTier == 0`; the
  // accumulator only ever sees the tracked balance, so pokeMyTier
  // would not activate the tier. Use `trackedTier > 0` so only
  // genuinely-qualifying tracked stake gets the auto-activation
  // promise.
  const lenderQualifiesByBalance =
    (discountTierData?.trackedTier ?? 0) > 0;
  const showConsentEnabledNoVpfi =
    consentEnabled === true &&
    data.effectiveAvgBps === 0 &&
    data.stampedBpsAtPreviousRollup === 0 &&
    !(isCanonical && lenderQualifiesByBalance);
  // Min-history pending = canonical chain + consent on + zero
  // effective discount + raw tier > 0. Only the time gate is
  // preventing activation; it will switch on automatically.
  const showMinHistoryPending =
    isCanonical &&
    consentEnabled === true &&
    data.effectiveAvgBps === 0 &&
    data.stampedBpsAtPreviousRollup === 0 &&
    lenderQualifiesByBalance;
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
              to=""
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

      {showMinHistoryPending && (
        <div
          className="alert alert-info"
          style={{ marginTop: 12 }}
          role="status"
        >
          <Clock size={14} />
          <div>
            <strong>{t('lenderDiscountCard.minHistoryPendingTitle')}</strong>
            <br />
            {t('lenderDiscountCard.minHistoryPendingBody')}
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
