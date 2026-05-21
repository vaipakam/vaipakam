/**
 * OfferGroupCard — the parent row for a range-order offer's children.
 *
 * Renders one card per `OfferGroup` from `useOfferGroupedLoans`:
 *   - Title: "Lender offer #N" / "Borrower offer #N" with cross-link
 *     to `/offers/:offerId` so the user can see the original terms.
 *   - Totals grid: principal sum, weighted-avg rate, MIN HF,
 *     earliest start, latest end, status counts.
 *   - Collateral list bucketed per asset (one row per collateral
 *     type when an offer accepts mixed).
 *   - Expand toggle: child loan rows render in a compact inline
 *     list with a link to each loan's detail page.
 *
 * Single-child groups can still render through this component — the
 * Dashboard's render logic decides whether to skip the parent shell
 * and render the child as a flat row when `children.length === 1`.
 *
 * Visual idiom matches the existing dashboard rows (status-badge
 * chips, mono asset cells, brand-coloured anchor links) so the
 * grouped view doesn't feel like a different surface.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { formatUnits } from 'viem';
import type { OfferGroup } from '../hooks/useOfferGroupedLoans';
import { LoanStatus, LOAN_STATUS_LABELS } from '../types/loan';

const BPS_DIVISOR = 100;
const HF_SCALE = 10n ** 18n;

/** Display the weighted-average rate as a percentage string. */
function formatRateBps(rateBps: bigint): string {
  if (rateBps === 0n) return '—';
  // `rateBps` is BPS (1/10000). Convert to %, two decimals.
  const whole = rateBps / BigInt(BPS_DIVISOR);
  const fractional = rateBps % BigInt(BPS_DIVISOR);
  return `${whole.toString()}.${fractional.toString().padStart(2, '0')}%`;
}

/** Display HF (1e18-scaled) as a one-decimal number, or "—". */
function formatHf(hf: bigint | null): string {
  if (hf === null) return '—';
  // hf is 1e18-scaled. Render as one decimal place.
  const tenths = (hf * 10n) / HF_SCALE;
  const whole = tenths / 10n;
  const frac = tenths % 10n;
  return `${whole.toString()}.${frac.toString()}`;
}

/** Best-effort short epoch timestamp → date string. Locale-aware. */
function formatTimestamp(ts: bigint): string {
  if (ts === 0n) return '—';
  const date = new Date(Number(ts) * 1000);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString();
}

interface Props {
  group: OfferGroup;
  /** Defaults to false. The page can lift this into a controlled
   *  state if it wants to remember expanded groups across re-renders;
   *  for the MVP we keep it local. */
  defaultExpanded?: boolean;
}

export function OfferGroupCard({ group, defaultExpanded = false }: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const collateralRows = Array.from(group.collateralByAsset.values());

  return (
    <div
      className="offer-group-card"
      data-offer-id={group.offerId.toString()}
      data-role={group.role}
    >
      <div className="offer-group-card__header">
        <div className="offer-group-card__title">
          <span className={`status-badge ${group.role}`}>
            {group.role === 'lender' ? 'Lender' : 'Borrower'}
          </span>
          <Link
            to={`/offers/${group.offerId.toString()}`}
            style={{ color: 'var(--brand)', textDecoration: 'none' }}
          >
            Offer #{group.offerId.toString()}
          </Link>
          <span className="offer-group-card__child-count">
            {group.counts.total === 1
              ? '1 loan'
              : `${group.counts.total} loans`}
            {group.counts.active > 0 && group.counts.total !== group.counts.active
              ? ` (${group.counts.active} active)`
              : ''}
          </span>
        </div>
        <button
          type="button"
          className="offer-group-card__toggle"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {expanded ? '▾ Hide loans' : '▸ Show loans'}
        </button>
      </div>

      <div className="offer-group-card__totals">
        <div>
          <span className="offer-group-card__label">Total filled</span>
          <span className="offer-group-card__value mono">
            {group.principalAssetType === 0
              ? formatUnits(group.totalPrincipal, 18)
              : group.totalPrincipal.toString()}
          </span>
        </div>
        <div>
          <span className="offer-group-card__label">Weighted rate</span>
          <span className="offer-group-card__value">
            {formatRateBps(group.effectiveRateBps)}
          </span>
        </div>
        <div>
          <span className="offer-group-card__label">Min HF</span>
          <span className="offer-group-card__value">
            {formatHf(group.minHf)}
          </span>
        </div>
        <div>
          <span className="offer-group-card__label">First started</span>
          <span className="offer-group-card__value">
            {formatTimestamp(group.earliestStartTime)}
          </span>
        </div>
        <div>
          <span className="offer-group-card__label">Latest end</span>
          <span className="offer-group-card__value">
            {formatTimestamp(group.latestEndTime)}
          </span>
        </div>
      </div>

      {collateralRows.length > 0 && (
        <div className="offer-group-card__collateral">
          <span className="offer-group-card__label">Collateral</span>
          <ul>
            {collateralRows.map((bucket) => (
              <li key={bucket.asset} className="mono">
                {bucket.assetType === 0
                  ? formatUnits(bucket.totalAmount, 18)
                  : bucket.childCount === 1
                    ? `#${bucket.firstTokenId.toString()}`
                    : `${bucket.childCount} items`}
                {' · '}
                <span style={{ opacity: 0.7 }}>
                  {bucket.asset.slice(0, 6)}…{bucket.asset.slice(-4)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {expanded && (
        <div className="offer-group-card__children">
          <table className="offer-group-card__child-table">
            <thead>
              <tr>
                <th>Loan</th>
                <th>Principal</th>
                <th>Rate</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {group.children.map((child) => (
                <tr key={child.id.toString()}>
                  <td>
                    <Link
                      to={`/loans/${child.id.toString()}`}
                      style={{ color: 'var(--brand)', textDecoration: 'none' }}
                    >
                      #{child.id.toString()}
                    </Link>
                  </td>
                  <td className="mono">
                    {child.assetType === 0
                      ? formatUnits(child.principal, 18)
                      : `#${child.principalTokenId.toString()}`}
                  </td>
                  <td>{formatRateBps(child.interestRateBps)}</td>
                  <td>
                    <span className={`status-pill status-${child.status}`}>
                      {LOAN_STATUS_LABELS[child.status as LoanStatus] ?? '—'}
                    </span>
                  </td>
                  <td>
                    <Link
                      to={`/loans/${child.id.toString()}`}
                      className="btn btn-secondary btn-sm"
                    >
                      View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
