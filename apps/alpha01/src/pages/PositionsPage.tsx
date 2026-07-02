import { useWallet } from '../context/WalletContext';
import { useMyLoans } from '../hooks/useIndexedLoans';
import { PositionCard } from '../components/PositionCard';

export function PositionsPage() {
  const { address, connect } = useWallet();
  const { data: loans, isLoading } = useMyLoans();

  if (!address) {
    return (
      <div>
        <h1 className="page-title">My positions</h1>
        <p className="page-subtitle">Connect your wallet to see active loans.</p>
        <button type="button" className="btn btn-primary" onClick={connect}>Connect wallet</button>
      </div>
    );
  }

  return (
    <div>
      <h1 className="page-title">My positions</h1>
      <p className="page-subtitle">Active loans where you are lender or borrower.</p>
      {isLoading ? <p>Loading…</p> : null}
      <div className="position-list">
        {(loans ?? []).map((loan) => (
          <PositionCard key={loan.loanId} loan={loan} />
        ))}
      </div>
      {!isLoading && (loans?.length ?? 0) === 0 ? (
        <p style={{ color: 'var(--text-secondary)' }}>No active positions yet.</p>
      ) : null}
    </div>
  );
}