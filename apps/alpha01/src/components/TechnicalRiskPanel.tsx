import {
  formatHealthFactor,
  formatLtvBps,
  MIN_HEALTH_FACTOR_1E18,
  plainHealthLabel,
} from '@vaipakam/defi-client';
import type { LoanRiskSnapshot } from '../hooks/useLoanRisks';
import { useMinHealthFactor1e18 } from '../hooks/useProtocolConfig';

interface Props {
  risk: LoanRiskSnapshot | undefined;
  loading?: boolean;
}

export function TechnicalRiskPanel({ risk, loading }: Props) {
  const { data: minHf1e18 = MIN_HEALTH_FACTOR_1E18 } = useMinHealthFactor1e18();

  if (loading) {
    return (
      <details className="technical-risk-panel" open>
        <summary>Technical risk</summary>
        <p style={{ marginTop: 8, color: 'var(--text-secondary)' }}>Loading on-chain risk metrics…</p>
      </details>
    );
  }

  const hf = risk?.healthFactor ?? null;
  const ltv = risk?.ltvBps ?? null;
  const plain = plainHealthLabel(hf, minHf1e18);

  return (
    <details className="technical-risk-panel" open data-testid="technical-risk-panel">
      <summary>Technical risk</summary>
      <dl className="technical-risk-grid">
        <div>
          <dt>Health factor</dt>
          <dd>{hf != null ? formatHealthFactor(hf) : '—'}</dd>
        </div>
        <div>
          <dt>Current LTV</dt>
          <dd>{ltv != null ? formatLtvBps(ltv) : '—'}</dd>
        </div>
        <div>
          <dt>Min HF at initiation</dt>
          <dd>{formatHealthFactor(minHf1e18)}</dd>
        </div>
        <div>
          <dt>Plain label</dt>
          <dd>{plain.label}</dd>
        </div>
      </dl>
      <p style={{ marginTop: 8, color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
        {plain.detail}
      </p>
    </details>
  );
}