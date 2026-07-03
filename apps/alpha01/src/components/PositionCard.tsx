import { Link } from 'react-router-dom';
import type { IndexedLoan } from '@vaipakam/defi-client';
import { formatBpsAsPercent, isNftRentalLoan, loanRoleForWallet, nftAssetKindLabel } from '@vaipakam/defi-client';
import { shortenAddr } from '@vaipakam/lib/address';
import { resolveSymbol } from '../lib/formatAsset';
import { useTokenMeta } from '../lib/tokenMeta';
import { useWallet } from '../context/WalletContext';

interface Props {
  loan: IndexedLoan;
}

export function PositionCard({ loan }: Props) {
  const { address } = useWallet();
  const lendingMeta = useTokenMeta(loan.lendingAsset);
  const collateralMeta = useTokenMeta(loan.collateralAsset);
  const walletRole = loanRoleForWallet(loan, address);
  const role =
    walletRole === 'both'
      ? 'Borrower & lender'
      : walletRole === 'lender'
        ? 'Lender'
        : walletRole === 'borrower'
          ? 'Borrower'
          : 'Holder';
  const counterparty =
    walletRole === 'lender' || walletRole === 'both'
      ? loan.borrower
      : walletRole === 'borrower'
        ? loan.lender
        : loan.lender;
  const rental = isNftRentalLoan(loan);

  return (
    <Link to={`/positions/${loan.loanId}`} className="position-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <strong>{rental ? `Rental #${loan.loanId}` : `Loan #${loan.loanId}`}</strong>
        <span style={{ color: 'var(--text-secondary)' }}>{role}</span>
      </div>
      <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
        {rental ? (
          <>
            {nftAssetKindLabel(loan.assetType)} #{loan.tokenId} · {loan.durationDays} days · daily fee position
          </>
        ) : (
          <>
            {resolveSymbol(lendingMeta, loan.lendingAsset)} · {resolveSymbol(collateralMeta, loan.collateralAsset)}{' '}
            collateral · {loan.durationDays} days · {formatBpsAsPercent(loan.interestRateBps)}
          </>
        )}
      </div>
      <div style={{ fontSize: '0.85rem' }}>
        Counterparty: {shortenAddr(counterparty)}
      </div>
    </Link>
  );
}