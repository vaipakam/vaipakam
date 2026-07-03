import {
  formatHealthFactor,
  formatLtvBps,
  MIN_HEALTH_FACTOR_1E18,
  plainHealthLabel,
} from '@vaipakam/defi-client';
import type { LoanRiskSnapshot } from '../hooks/useLoanRisks';

interface Props {
  risk: LoanRiskSnapshot | undefined;
  loading?: boolean;
}

export function TechnicalRiskPanel({ risk, loading }: Props) {
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
  const plain = plainHealthLabel(hf);

  return (
    <details className="technical-risk-panel" open data-testid="technical-risk-panel">
      <summary>Technical risk</summary>
      <dl className="technical-risk-grid">
        <div>
          <dt>Health factor</dt>
          <dd>{hf != null && hf > 0n ? formatHealthFactor(hf) : '—'}</dd>
        </div>
        <div>
          <dt>Current LTV</dt>
          <dd>{ltv != null && ltv > 0n ? formatLtvBps(ltv) : '—'}</dd>
        </div>
        <div>
          <dt>Min HF at initiation</dt>
          <dd>{formatHealthFactor(MIN_HEALTH_FACTOR_1E18)}</dd>
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