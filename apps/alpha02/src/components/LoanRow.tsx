/** One position in a list: role, plain state, amounts, link to detail. */
import { Link } from 'react-router-dom';
import { copy } from '../content/copy';
import { formatBpsAsPercent, formatTokenAmount } from '../lib/format';
import { loanStateView } from '../lib/loanState';
import { useTokenMeta } from '../contracts/erc20';
import type { PositionLoan } from '../data/hooks';

export function LoanRow({ loan }: { loan: PositionLoan }) {
  const principalMeta = useTokenMeta(loan.lendingAsset);
  const view = loanStateView(loan);

  const symbol = principalMeta.data?.symbol ?? '';
  const amount = principalMeta.data
    ? formatTokenAmount(loan.principal, principalMeta.data.decimals)
    : '…';

  return (
    <Link to={`/positions/${loan.loanId}`} className="item-row">
      <span className="row-main">
        <span className="row-title">
          {loan.role === 'borrower' ? copy.positions.roleBorrower : copy.positions.roleLender}{' '}
          {amount} {symbol}
        </span>
        <br />
        <span className="row-sub">
          Loan #{loan.loanId} · {formatBpsAsPercent(loan.interestRateBps)} yearly
          interest
        </span>
      </span>
      <span className={`badge badge-${view.badge}`}>{view.label}</span>
    </Link>
  );
}
