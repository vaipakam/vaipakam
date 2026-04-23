import { Gift, Info, Clock } from 'lucide-react';
import { useLoanLenderDiscount } from '../../hooks/useLoanLenderDiscount';

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
  const loanIdBig = loanId ? safeBigInt(loanId) : null;
  const lenderAddr = typeof lender === 'string' && lender.length > 0
    ? (lender as `0x${string}`)
    : null;

  const { data, isLoading, error } = useLoanLenderDiscount(
    loanIdBig,
    lenderAddr,
  );

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

  return (
    <div className="card">
      <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Gift size={14} />
        Lender Yield-Fee Discount
      </div>

      <div className="data-row">
        <span className="data-label">Effective so far (time-weighted)</span>
        <span className="data-value">{effectivePct}%</span>
      </div>
      <div className="data-row">
        <span className="data-label">Currently earning (stamped tier)</span>
        <span className="data-value">{stampedPct}%</span>
      </div>
      <div className="data-row">
        <span className="data-label">
          <Clock size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
          Window elapsed
        </span>
        <span className="data-value">{formatDuration(data.windowSeconds)}</span>
      </div>

      {tiersDiffer && (
        <div
          className="alert alert-info"
          style={{ marginTop: 12 }}
          role="status"
        >
          <Info size={14} />
          <div>
            At settlement the treasury cut on this loan's yield is reduced by
            the time-weighted average <strong>{effectivePct}%</strong>, not
            your current <strong>{stampedPct}%</strong> rate. Topping up VPFI
            just before repay won't capture the full current-tier discount —
            only the share proportional to how long it was held during the
            loan.
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

function formatDuration(seconds: number): string {
  if (seconds <= 0) return '0s';
  const days = Math.floor(seconds / 86_400);
  if (days >= 1) {
    const hours = Math.floor((seconds % 86_400) / 3_600);
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  const hours = Math.floor(seconds / 3_600);
  if (hours >= 1) {
    const mins = Math.floor((seconds % 3_600) / 60);
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  }
  const mins = Math.floor(seconds / 60);
  return mins >= 1 ? `${mins}m` : `${seconds}s`;
}
