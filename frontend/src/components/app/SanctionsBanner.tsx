import { AlertOctagon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSanctionsCheck } from '../../hooks/useSanctionsCheck';
import type { Address } from 'viem';

/**
 * Pre-signature sanctions-screening banner. When the connected wallet
 * (or, on an accept flow, the offer's creator) is flagged by the
 * configured Chainalysis-style oracle, this renders a red banner with
 * a clear explanation of why the next action will revert. The
 * underlying `useSanctionsCheck` hook fails open — no oracle
 * configured or oracle outage both render nothing, matching the
 * contract's fail-open posture.
 *
 * Callers that need to gate UI state (disable the submit button, hide
 * an action) should read `isSanctioned` from `useSanctionsCheck`
 * directly. This component is for the user-visible warning only.
 */
export function SanctionsBanner({
  address,
  label,
}: {
  address: Address | null | undefined;
  /** Already-localised label for which wallet is flagged — callers
   *  should pass `t('banners.sanctionsLabelWallet')` etc. directly. */
  label: string;
}) {
  const { t } = useTranslation();
  const { isSanctioned, loading } = useSanctionsCheck(address);
  if (loading) return null;
  if (!isSanctioned) return null;
  return (
    <div
      className="alert alert-error"
      role="alert"
      style={{
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
        marginBottom: 12,
      }}
    >
      <AlertOctagon size={18} style={{ flex: '0 0 auto', marginTop: 2 }} />
      <div style={{ fontSize: '0.86rem', lineHeight: 1.5 }}>
        <strong>{t('banners.sanctionsMatchTitle', { label })}</strong>
        <div style={{ marginTop: 6 }}>{t('banners.sanctionsMatchLine1')}</div>
        <div style={{ marginTop: 6 }}>{t('banners.sanctionsMatchLine2')}</div>
        <div style={{ marginTop: 6 }}>{t('banners.sanctionsMatchLine3')}</div>
      </div>
    </div>
  );
}
