/**
 * The review receipt — the single trust surface every write flow
 * shows before signing (BasicUserUXSimplification.md, "Step 4").
 * Six fixed rows, same order everywhere: You receive / You lock /
 * You may owe / You can lose / Fees / When this ends. Protocol fees
 * and network gas stay separate concepts.
 */
import { copy } from '../content/copy';

export interface ReceiptData {
  youReceive: string;
  youLock: string;
  youMayOwe: string;
  youCanLose: string;
  fees: string;
  whenThisEnds: string;
}

export function ReviewReceipt({ data }: { data: ReceiptData }) {
  const rows: Array<{ label: string; value: string; risk?: boolean }> = [
    { label: copy.receipt.youReceive, value: data.youReceive },
    { label: copy.receipt.youLock, value: data.youLock },
    { label: copy.receipt.youMayOwe, value: data.youMayOwe },
    { label: copy.receipt.youCanLose, value: data.youCanLose, risk: true },
    { label: copy.receipt.fees, value: data.fees },
    { label: copy.receipt.whenThisEnds, value: data.whenThisEnds },
  ];

  return (
    <div>
      <h3>{copy.receipt.heading}</h3>
      <dl className="receipt" style={{ margin: 0 }}>
        {rows.map((row) => (
          <div
            key={row.label}
            className={`receipt-row ${row.risk ? 'receipt-risk' : ''}`}
          >
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
      <p className="muted" style={{ marginTop: 8 }}>
        {copy.receipt.gasNote}
      </p>
    </div>
  );
}
