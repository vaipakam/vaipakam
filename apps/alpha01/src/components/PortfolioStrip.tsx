import { Link } from 'react-router-dom';
import {
  formatHealthFactor,
  isHealthFactorAtRisk,
  isNftRentalLoan,
  loanRoleForWallet,
  MIN_HEALTH_FACTOR_1E18,
} from '@vaipakam/defi-client';
import type { IndexedLoan } from '@vaipakam/defi-client';
import { useWallet } from '../context/WalletContext';
import { useLoanRisks } from '../hooks/useLoanRisks';
import { useMinHealthFactor1e18 } from '../hooks/useProtocolConfig';

interface Props {
  loans: IndexedLoan[];
  offerCount: number;
}

export function PortfolioStrip({ loans, offerCount }: Props) {
  const { address } = useWallet();
  const { data: minHf1e18 = MIN_HEALTH_FACTOR_1E18 } = useMinHealthFactor1e18();
  const debtLoanIds = loans.filter((l) => !isNftRentalLoan(l) && l.status === 'active').map((l) => l.loanId);
  const { data: risks, isLoading: risksLoading, isError: risksError } = useLoanRisks(debtLoanIds);

  const borrowerLoans = loans.filter(
    (l) => l.status === 'active' && (loanRoleForWallet(l, address) === 'borrower' || loanRoleForWallet(l, address) === 'both'),
  );
  const lenderLoans = loans.filter(
    (l) => l.status === 'active' && (loanRoleForWallet(l, address) === 'lender' || loanRoleForWallet(l, address) === 'both'),
  );
  const atRisk =
    risksError || !risks
      ? null
      : debtLoanIds.filter((id) => {
          const hf = risks.get(id)?.healthFactor;
          return isHealthFactorAtRisk(hf, minHf1e18);
        }).length;

  const minHfLabel = formatHealthFactor(minHf1e18);

  return (
    <div className="portfolio-strip" data-testid="portfolio-strip">
      <div className="portfolio-strip-metric">
        <span className="portfolio-strip-value">{borrowerLoans.length}</span>
        <span className="portfolio-strip-label">Borrower / renter</span>
      </div>
      <div className="portfolio-strip-metric">
        <span className="portfolio-strip-value">{lenderLoans.length}</span>
        <span className="portfolio-strip-label">Lender / owner</span>
      </div>
      <div className="portfolio-strip-metric">
        <span className="portfolio-strip-value">{offerCount}</span>
        <span className="portfolio-strip-label">Open offers</span>
      </div>
      <div className="portfolio-strip-metric">
        <span className="portfolio-strip-value">
          {risksLoading ? '…' : atRisk == null ? '—' : atRisk}
        </span>
        <span className="portfolio-strip-label">HF below {minHfLabel}</span>
      </div>
      <Link to="/positions" className="portfolio-strip-link">
        Open positions →
      </Link>
    </div>
  );
}