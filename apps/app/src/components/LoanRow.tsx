/** One position in a list: role, plain state, amounts, link to detail.
 *  Rentals (NFT principal) read as rentals, never as debt. */
import { Link } from 'react-router-dom';
import { copy } from '../content/copy';
import { formatBpsAsPercent, formatTokenAmount, shortAddress } from '../lib/format';
import { loanStateView, loanStateLabel } from '../lib/loanState';
import { useTokenMeta } from '../contracts/erc20';
import { AssetType } from '../lib/types';
import type { PositionLoan } from '../data/hooks';
import { healthView, useLoanRisk } from '../data/risk';

export function LoanRow({
  loan,
  claimWaiting,
}: {
  loan: PositionLoan;
  /** UX-024 — chain-confirmed unclaimed payout on this side (from
   *  useMyClaimables); renders an explicit "Claim waiting" chip so a
   *  defaulted/repaid row with money on the table says so. */
  claimWaiting?: boolean;
}) {
  const isRental = loan.assetType !== AssetType.ERC20;
  const principalMeta = useTokenMeta(isRental ? undefined : loan.lendingAsset);
  const view = loanStateView(loan);
  // UX-003 — the time-based badge alone can show a reassuring green on
  // a loan hovering at the liquidation line. For active priced loans,
  // let a WORSE health state override the badge (never a better one —
  // "past due" stays past due even at a healthy HF).
  const watchHealth = loan.status === 'active' && !isRental;
  const risk = useLoanRisk(watchHealth ? loan.loanId : undefined, watchHealth);
  const health = risk.data?.priced ? healthView(risk.data) : null;
  const badgeRank = { ok: 0, neutral: 0, warn: 1, danger: 2 } as const;
  const healthOverrides =
    health !== null &&
    health.badge !== 'ok' &&
    badgeRank[health.badge] > badgeRank[view.badge];
  // While the health read is loading or errored, a green time badge
  // would re-assert exactly the false-safe state this override exists
  // to remove — go neutral until health is actually known (Codex
  // #1166 r1). Worse-than-ok time badges keep their own urgency.
  const healthUnknown = watchHealth && risk.data === undefined;

  const symbol = principalMeta.data?.symbol ?? '';
  const amount = principalMeta.data
    ? formatTokenAmount(loan.principal, principalMeta.data.decimals)
    : '…';

  return (
    <Link to={`/positions/${loan.loanId}`} className="item-row">
      <span className="row-main">
        <span className="row-title">
          {isRental
            ? `${loan.role === 'borrower' ? copy.loanRow.youRent : copy.loanRow.youRentOut} NFT ${shortAddress(loan.lendingAsset)} #${loan.tokenId}`
            : `${loan.role === 'borrower' ? copy.positions.roleBorrower : copy.positions.roleLender} ${amount} ${symbol}`}
        </span>
        <br />
        <span className="row-sub">
          {isRental
            ? copy.positions.rowRental(loan.loanId)
            : copy.positions.rowLoan(loan.loanId, formatBpsAsPercent(loan.interestRateBps))}
        </span>
      </span>
      {claimWaiting ? (
        <span className="badge badge-ok">{copy.positions.claimWaiting}</span>
      ) : null}
      {healthOverrides && health ? (
        <span
          className={`badge badge-${health.badge}`}
          title={copy.risk.healthTitle(health.ratio)}
        >
          {health.label}
        </span>
      ) : healthUnknown && view.badge === 'ok' ? (
        <span className="badge badge-neutral" title={copy.risk.listCheckingTitle}>
          {loanStateLabel(view, copy.loanState)} · {copy.risk.listChecking}
        </span>
      ) : (
        <span className={`badge badge-${view.badge}`}>{loanStateLabel(view, copy.loanState)}</span>
      )}
    </Link>
  );
}
