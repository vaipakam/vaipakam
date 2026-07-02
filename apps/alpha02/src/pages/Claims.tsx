/**
 * Claim Center — everything ready to collect, each row saying what
 * will be received and why (Journey C1). Claims deep-link to the loan
 * detail page, which owns the actual claim action.
 */
import { Gift, LoaderCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useModal } from 'connectkit';
import { copy } from '../content/copy';
import { useMyClaimables } from '../data/hooks';
import { useActiveChain } from '../chain/useActiveChain';
import { EmptyState, UnavailableState } from '../components/EmptyState';
import { useTokenMeta } from '../contracts/erc20';
import { formatTokenAmount } from '../lib/format';
import type { PositionLoan } from '../data/hooks';

function ClaimRow({ loan }: { loan: PositionLoan }) {
  const principalMeta = useTokenMeta(loan.lendingAsset);
  const collateralMeta = useTokenMeta(loan.collateralAsset);

  const what =
    loan.role === 'lender'
      ? loan.status === 'repaid'
        ? principalMeta.data
          ? `${formatTokenAmount(loan.principal, principalMeta.data.decimals)} ${principalMeta.data.symbol} + interest`
          : 'Repaid funds'
        : collateralMeta.data
          ? `${formatTokenAmount(loan.collateralAmount, collateralMeta.data.decimals)} ${collateralMeta.data.symbol} collateral`
          : 'Collateral'
      : collateralMeta.data
        ? `${formatTokenAmount(loan.collateralAmount, collateralMeta.data.decimals)} ${collateralMeta.data.symbol} collateral back`
        : 'Your collateral back';

  const why =
    loan.role === 'lender'
      ? loan.status === 'repaid'
        ? 'The borrower repaid this loan.'
        : 'The loan defaulted — the collateral is yours to claim.'
      : 'You repaid this loan, so your collateral is released.';

  return (
    <Link to={`/positions/${loan.loanId}`} className="item-row">
      <span className="row-main">
        <span className="row-title">{what}</span>
        <br />
        <span className="row-sub">
          Loan #{loan.loanId} · {why}
        </span>
      </span>
      <span className="btn btn-primary btn-sm">{copy.claims.claim}</span>
    </Link>
  );
}

export function Claims() {
  const { isConnected } = useActiveChain();
  const { setOpen } = useModal();
  const claimables = useMyClaimables();

  return (
    <div>
      <h1 className="page-title">{copy.claims.title}</h1>
      <p className="page-lede">{copy.claims.lede}</p>

      {!isConnected ? (
        <EmptyState
          icon={Gift}
          title={copy.wallet.connectFirst}
          action={
            <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
              {copy.wallet.connect}
            </button>
          }
        />
      ) : claimables.isLoading || claimables.data === undefined ? (
        <EmptyState icon={LoaderCircle} title="Checking for claims…" />
      ) : claimables.data === null ? (
        <UnavailableState body={copy.claims.unavailable} />
      ) : claimables.data.length === 0 ? (
        <EmptyState icon={Gift} title={copy.claims.empty} />
      ) : (
        <div className="row-list">
          {claimables.data.map((loan) => (
            <ClaimRow key={`${loan.loanId}-${loan.role}`} loan={loan} />
          ))}
        </div>
      )}
    </div>
  );
}
