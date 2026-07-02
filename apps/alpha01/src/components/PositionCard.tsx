import { Link } from 'react-router-dom';
import type { IndexedLoan } from '@vaipakam/defi-client';
import { formatBpsAsPercent } from '@vaipakam/defi-client';
import { shortenAddr } from '@vaipakam/lib/address';
import { useWallet } from '../context/WalletContext';

interface Props {
  loan: IndexedLoan;
}

export function PositionCard({ loan }: Props) {
  const { address } = useWallet();
  const role = address?.toLowerCase() === loan.lender.toLowerCase() ? 'Lender' : 'Borrower';

  return (
    <Link to={`/positions/${loan.loanId}`} className="position-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <strong>Loan #{loan.loanId}</strong>
        <span style={{ color: 'var(--text-secondary)' }}>{role}</span>
      </div>
      <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
        {shortenAddr(loan.lendingAsset)} · {loan.durationDays} days · {formatBpsAsPercent(loan.interestRateBps)}
      </div>
      <div style={{ fontSize: '0.85rem' }}>
        Counterparty: {shortenAddr(role === 'Lender' ? loan.borrower : loan.lender)}
      </div>
    </Link>
  );
}