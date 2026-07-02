import { Link } from 'react-router-dom';
import { useMyLoans } from '../hooks/useIndexedLoans';
import { PositionCard } from '../components/PositionCard';

export function ClaimsPage() {
  const { data: loans, isLoading } = useMyLoans();

  return (
    <div>
      <h1 className="page-title">Claims</h1>
      <p className="page-subtitle">
        Settled positions with funds to claim. Open a loan to claim as lender or borrower.
      </p>
      {isLoading ? <p>Loading…</p> : null}
      <div className="position-list">
        {(loans ?? []).map((loan) => (
          <PositionCard key={loan.loanId} loan={loan} />
        ))}
      </div>
      {!isLoading && (loans?.length ?? 0) === 0 ? (
        <p style={{ color: 'var(--text-secondary)' }}>
          Nothing to claim right now. <Link to="/positions">View positions</Link>
        </p>
      ) : null}
    </div>
  );
}