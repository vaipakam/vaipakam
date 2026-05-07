import type { ReactNode } from 'react';
import { ShieldCheck, AlertTriangle, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useTxSimulation, type TxSimInput, type SimResult } from '../../hooks/useTxSimulation';

interface SimulationPreviewProps {
  /** Pending tx to scan. Pass `null` to suppress the panel. */
  tx: TxSimInput | null;
  /** Extra content to render under the classification line. */
  children?: ReactNode;
}

/**
 * Phase 8b.2 — inline simulation preview card for review modals.
 *
 * Calls Blockaid's Transaction Scanner on the pending calldata and
 * renders the classification (benign / warning / malicious) + a
 * bulleted list of state changes ("Send X USDC", "Receive Vaipakam
 * position NFT", etc.). Fails soft on API unavailable — the panel
 * simply collapses to a subdued "preview unavailable" footer so the
 * review flow doesn't block.
 *
 * Used in AcceptReviewModal (OfferBook), CreateOffer review, and
 * future repay / add-collateral / preclose flows. The hosting modal
 * places this between the risk disclosures and the Confirm button.
 */
export function SimulationPreview({ tx, children }: SimulationPreviewProps) {
  const { t } = useTranslation();
  const { result } = useTxSimulation(tx);

  if (!tx) return null;

  if (result.status === 'unavailable') {
    return (
      <div
        style={{
          margin: '8px 0',
          fontSize: '0.78rem',
          opacity: 0.6,
          textAlign: 'center',
        }}
      >
        {t('simulationPreview.unavailable')}
      </div>
    );
  }

  if (result.status === 'loading') {
    return (
      <div
        className="alert"
        style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}
      >
        <Loader2 size={16} className="spin" />
        <span style={{ fontSize: '0.85rem' }}>{t('simulationPreview.scanning')}</span>
      </div>
    );
  }

  if (result.status === 'error') {
    return (
      <div
        className="alert alert-warning"
        style={{ marginTop: 8, fontSize: '0.82rem' }}
      >
        <AlertTriangle size={16} />
        <span>
          {t('simulationPreview.errorPrefix')} {result.errorMessage}{t('simulationPreview.errorSuffix')}
        </span>
      </div>
    );
  }

  const classStyle = _classificationStyle(result.classification, t);
  return (
    <div
      className="alert"
      style={{
        marginTop: 8,
        borderColor: classStyle.border,
        background: classStyle.bg,
      }}
    >
      {classStyle.icon}
      <div style={{ fontSize: '0.88rem', flex: 1 }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>
          {classStyle.title}
        </div>
        {result.warnings && result.warnings.length > 0 && (
          <ul style={{ margin: '4px 0 8px 16px', padding: 0 }}>
            {result.warnings.map((w, i) => (
              <li key={i} style={{ fontSize: '0.82rem' }}>
                {w}
              </li>
            ))}
          </ul>
        )}
        {result.stateChanges && result.stateChanges.length > 0 && (
          <div style={{ marginTop: 4 }}>
            <div
              style={{
                fontSize: '0.78rem',
                opacity: 0.8,
                marginBottom: 2,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              {t('simulationPreview.expectedStateChanges')}
            </div>
            <ul style={{ margin: '0 0 0 16px', padding: 0 }}>
              {result.stateChanges.slice(0, 6).map((change, i) => (
                <li key={i} style={{ fontSize: '0.82rem' }}>
                  {change.description}
                </li>
              ))}
              {result.stateChanges.length > 6 && (
                <li style={{ fontSize: '0.76rem', opacity: 0.65 }}>
                  {t('simulationPreview.plusMore', { count: result.stateChanges.length - 6 })}
                </li>
              )}
            </ul>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

function _classificationStyle(c: SimResult['classification'], t: TFunction) {
  switch (c) {
    case 'malicious':
      return {
        border: 'var(--accent-red)',
        bg: 'rgba(239, 68, 68, 0.08)',
        icon: <AlertTriangle size={18} style={{ color: 'var(--accent-red)' }} />,
        title: t('simulationPreview.titleMalicious'),
      };
    case 'warning':
      return {
        border: 'var(--accent-orange, #f59e0b)',
        bg: 'rgba(245, 158, 11, 0.08)',
        icon: (
          <AlertTriangle size={18} style={{ color: 'var(--accent-orange, #f59e0b)' }} />
        ),
        title: t('simulationPreview.titleWarning'),
      };
    default:
      return {
        border: 'var(--accent-green, #10b981)',
        bg: 'rgba(16, 185, 129, 0.05)',
        icon: (
          <ShieldCheck size={18} style={{ color: 'var(--accent-green, #10b981)' }} />
        ),
        title: t('simulationPreview.titlePreview'),
      };
  }
}
