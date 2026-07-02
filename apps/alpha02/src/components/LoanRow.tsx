/** One position in a list: role, plain state, amounts, link to detail.
 *  Rentals (NFT principal) read as rentals, never as debt. */
import { Link } from 'react-router-dom';
import { copy } from '../content/copy';
import { formatBpsAsPercent, formatTokenAmount, shortAddress } from '../lib/format';
import { loanStateView } from '../lib/loanState';
import { useTokenMeta } from '../contracts/erc20';
import { AssetType } from '../lib/types';
import type { PositionLoan } from '../data/hooks';

export function LoanRow({ loan }: { loan: PositionLoan }) {
  const isRental = loan.assetType !== AssetType.ERC20;
  const principalMeta = useTokenMeta(isRental ? undefined : loan.lendingAsset);
  const view = loanStateView(loan);

  const symbol = principalMeta.data?.symbol ?? '';
  const amount = principalMeta.data
    ? formatTokenAmount(loan.principal, principalMeta.data.decimals)
    : '…';

  return (
    <Link to={`/positions/${loan.loanId}`} className="item-row">
      <span className="row-main">
        <span className="row-title">
          {isRental
            ? `${loan.role === 'borrower' ? 'You rent' : 'You rent out'} NFT ${shortAddress(loan.lendingAsset)} #${loan.tokenId}`
            : `${loan.role === 'borrower' ? copy.positions.roleBorrower : copy.positions.roleLender} ${amount} ${symbol}`}
        </span>
        <br />
        <span className="row-sub">
          {isRental
            ? `Rental #${loan.loanId} · fees prepaid`
            : `Loan #${loan.loanId} · ${formatBpsAsPercent(loan.interestRateBps)} yearly interest`}
        </span>
      </span>
      <span className={`badge badge-${view.badge}`}>{view.label}</span>
    </Link>
  );
}
