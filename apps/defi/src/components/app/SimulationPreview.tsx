import type { CSSProperties, ReactNode } from 'react';
import { ShieldCheck, AlertTriangle, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTxSimulation, type TxSimInput } from '../../hooks/useTxSimulation';

interface SimulationPreviewProps {
  /** Pending tx to preview. Pass `null` to suppress the panel. */
  tx: TxSimInput | null;
  /** Extra content rendered under the result line. */
  children?: ReactNode;
}

/**
 * ET-001 — inline pre-sign transaction preflight card for review
 * modals.
 *
 * Runs the pending calldata as a viem `eth_call` (`useTxSimulation`)
 * — a free, read-only simulation against the chain's own RPC — and
 * tells the user whether the transaction will succeed or revert
 * before they spend gas signing it. Advisory only: on a revert it
 * *warns*, it never blocks; on an RPC hiccup it collapses to a
 * subdued footer.
 *
 * The "what you're agreeing to" detail (amounts, assets, rate) is
 * already shown by the hosting review modal — this card adds the
 * will-it-succeed verdict on top. Used in AcceptReviewModal
 * (OfferBook), CreateOffer review, the repay / add-collateral flows
 * (LoanDetails) and the BuyVPFI cards.
 */
export function SimulationPreview({ tx, children }: SimulationPreviewProps) {
  const { t } = useTranslation();
  const { result } = useTxSimulation(tx);

  // `idle` (no scan run yet) renders nothing — never flash a verdict
  // before a result exists.
  if (!tx || result.status === 'idle') return null;

  if (result.status === 'unavailable') {
    return (
      <div style={SUBDUED_FOOTER}>{t('simulationPreview.unavailable')}</div>
    );
  }

  if (result.status === 'loading') {
    return (
      <div
        className="alert"
        style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}
      >
        <Loader2 size={16} className="spin" />
        <span style={{ fontSize: '0.85rem' }}>
          {t('simulationPreview.scanning')}
        </span>
      </div>
    );
  }

  if (result.status === 'revert') {
    return (
      <div
        className="alert"
        style={{
          marginTop: 8,
          borderColor: 'var(--accent-orange, #f59e0b)',
          background: 'rgba(245, 158, 11, 0.08)',
        }}
      >
        <AlertTriangle
          size={18}
          style={{ color: 'var(--accent-orange, #f59e0b)' }}
        />
        <div style={{ fontSize: '0.88rem', flex: 1 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            {t('simulationPreview.revertPrefix')}
          </div>
          {result.revertReason && (
            <div style={{ fontSize: '0.82rem' }}>
              <code>{result.revertReason}</code>
            </div>
          )}
          <div style={{ fontSize: '0.82rem', marginTop: 4, opacity: 0.85 }}>
            {t('simulationPreview.revertSuffix')}
          </div>
          {children}
        </div>
      </div>
    );
  }

  // status === 'ok'
  return (
    <div
      className="alert"
      style={{
        marginTop: 8,
        borderColor: 'var(--accent-green, #10b981)',
        background: 'rgba(16, 185, 129, 0.05)',
      }}
    >
      <ShieldCheck size={18} style={{ color: 'var(--accent-green, #10b981)' }} />
      <div style={{ fontSize: '0.88rem', flex: 1 }}>
        <div style={{ fontWeight: 600 }}>{t('simulationPreview.okTitle')}</div>
        {children}
      </div>
    </div>
  );
}

const SUBDUED_FOOTER: CSSProperties = {
  margin: '8px 0',
  fontSize: '0.78rem',
  opacity: 0.6,
  textAlign: 'center',
};
