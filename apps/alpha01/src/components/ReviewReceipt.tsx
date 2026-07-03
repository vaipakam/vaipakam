import type { ReactNode } from 'react';
import { useMode } from '../context/ModeContext';

export interface ReviewReceiptRow {
  label: string;
  value: ReactNode;
  hint?: string;
}

export interface ReviewReceiptView {
  youReceive: ReviewReceiptRow;
  youLock: ReviewReceiptRow;
  youMayOwe: ReviewReceiptRow;
  youCanLose: ReviewReceiptRow;
  fees: ReviewReceiptRow;
  whenEnds: ReviewReceiptRow;
  technicalDetails?: ReviewReceiptRow[];
}

interface Props {
  data: ReviewReceiptView;
}

function Row({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="receipt-row">
      <div className="receipt-label">{label}</div>
      <div className="receipt-value">{value}</div>
      {hint ? <div className="receipt-hint">{hint}</div> : null}
    </div>
  );
}

export function ReviewReceipt({ data }: Props) {
  const { mode } = useMode();

  return (
    <div className="card receipt-grid" data-testid="review-receipt">
      <Row label="You receive" value={data.youReceive.value} hint={data.youReceive.hint} />
      <Row label="You lock" value={data.youLock.value} hint={data.youLock.hint} />
      <Row label="You may owe" value={data.youMayOwe.value} hint={data.youMayOwe.hint} />
      <Row label="You can lose" value={data.youCanLose.value} hint={data.youCanLose.hint} />
      <Row label="Fees" value={data.fees.value} hint={data.fees.hint} />
      <Row label="When this ends" value={data.whenEnds.value} hint={data.whenEnds.hint} />
      {mode === 'advanced' && data.technicalDetails?.length ? (
        <details>
          <summary>Technical details</summary>
          <div className="receipt-grid" style={{ marginTop: 12 }}>
            {data.technicalDetails.map((d) => (
              <Row key={d.label} label={d.label} value={d.value} hint={d.hint} />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}