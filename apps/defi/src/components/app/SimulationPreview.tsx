import type { CSSProperties, ReactNode } from 'react';
import { ShieldCheck, AlertTriangle, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  useTxSimulation,
  type TxSimInput,
  type ScanResult,
  type ScanParam,
} from '../../hooks/useTxSimulation';

interface SimulationPreviewProps {
  /** Pending tx to scan. Pass `null` to suppress the panel. */
  tx: TxSimInput | null;
  /** Extra content to render under the scan result. */
  children?: ReactNode;
}

/**
 * ET-001 — inline transaction-scan preview card for review modals.
 *
 * Calls the GoPlus-backed `/scan/tx` proxy on the pending calldata
 * (via `useTxSimulation`) and renders a GoPlus-native result: an
 * overall verdict (safe / warning / danger), the decoded call
 * (method + target contract), GoPlus risk warnings, and the decoded
 * parameters — flagging any address parameter GoPlus marks malicious.
 *
 * GoPlus is a risk-data API, not a balance-diff simulator, so this
 * shows *what the transaction calls and whether anything is flagged*
 * rather than a predicted asset diff. It fails soft — on scanner
 * unavailability the panel collapses to a subdued footer and never
 * blocks the review flow.
 *
 * Used in AcceptReviewModal (OfferBook), CreateOffer review, the
 * repay / add-collateral flows (LoanDetails), and the BuyVPFI cards.
 * The hosting modal places this between the risk disclosures and the
 * Confirm button.
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
        <span style={{ fontSize: '0.85rem' }}>
          {t('simulationPreview.scanning')}
        </span>
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
          {t('simulationPreview.errorPrefix')} {result.errorMessage}
          {t('simulationPreview.errorSuffix')}
        </span>
      </div>
    );
  }

  const v = _verdictStyle(result.verdict, t);
  const params = result.params ?? [];
  return (
    <div
      className="alert"
      style={{ marginTop: 8, borderColor: v.border, background: v.bg }}
    >
      {v.icon}
      <div style={{ fontSize: '0.88rem', flex: 1 }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>{v.title}</div>

        {result.warnings && result.warnings.length > 0 && (
          <ul style={{ margin: '4px 0 8px 16px', padding: 0 }}>
            {result.warnings.map((w, i) => (
              <li key={i} style={{ fontSize: '0.82rem' }}>
                {w}
              </li>
            ))}
          </ul>
        )}

        {result.method && (
          <div style={{ marginTop: 4 }}>
            <div style={_sectionLabel}>{t('simulationPreview.decodedCall')}</div>
            <div style={{ fontSize: '0.82rem' }}>
              <code>{result.method}</code>
              {result.contractName ? ` · ${result.contractName}` : ''}
            </div>
          </div>
        )}

        {params.length > 0 && (
          <div style={{ marginTop: 6 }}>
            <div style={_sectionLabel}>
              {t('simulationPreview.parameters')}
            </div>
            <ul style={{ margin: '0 0 0 16px', padding: 0 }}>
              {params.slice(0, 6).map((p, i) => (
                <ParamRow key={i} param={p} t={t} />
              ))}
              {params.length > 6 && (
                <li style={{ fontSize: '0.76rem', opacity: 0.65 }}>
                  {t('simulationPreview.plusMore', { count: params.length - 6 })}
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

const _sectionLabel: CSSProperties = {
  fontSize: '0.78rem',
  opacity: 0.8,
  marginBottom: 2,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};

/** Render one decoded parameter; flag a malicious address inline. */
function ParamRow({ param, t }: { param: ScanParam; t: TFunction }) {
  const addr = param.address;
  // Address params show the (shortened) address + GoPlus enrichment;
  // value params show the decoded value verbatim.
  const display = addr
    ? `${addr.address.slice(0, 6)}…${addr.address.slice(-4)}`
    : (param.value ?? '—');
  return (
    <li style={{ fontSize: '0.82rem' }}>
      <span style={{ opacity: 0.75 }}>
        {param.name || '(unnamed)'}
        {param.type ? ` (${param.type})` : ''}:
      </span>{' '}
      <code>{display}</code>
      {addr?.symbol ? ` · ${addr.symbol}` : ''}
      {addr?.standard ? ` · ${addr.standard}` : ''}
      {addr?.malicious && (
        <span
          style={{
            color: 'var(--accent-red)',
            fontWeight: 600,
            marginLeft: 6,
          }}
        >
          ⚠ {t('simulationPreview.flaggedMalicious')}
        </span>
      )}
    </li>
  );
}

function _verdictStyle(v: ScanResult['verdict'], t: TFunction) {
  switch (v) {
    case 'danger':
      return {
        border: 'var(--accent-red)',
        bg: 'rgba(239, 68, 68, 0.08)',
        icon: (
          <AlertTriangle size={18} style={{ color: 'var(--accent-red)' }} />
        ),
        title: t('simulationPreview.titleDanger'),
      };
    case 'warning':
      return {
        border: 'var(--accent-orange, #f59e0b)',
        bg: 'rgba(245, 158, 11, 0.08)',
        icon: (
          <AlertTriangle
            size={18}
            style={{ color: 'var(--accent-orange, #f59e0b)' }}
          />
        ),
        title: t('simulationPreview.titleWarning'),
      };
    default:
      return {
        border: 'var(--accent-green, #10b981)',
        bg: 'rgba(16, 185, 129, 0.05)',
        icon: (
          <ShieldCheck
            size={18}
            style={{ color: 'var(--accent-green, #10b981)' }}
          />
        ),
        title: t('simulationPreview.titleSafe'),
      };
  }
}
