import type { SupportedChain } from '../../chain/chains';
import { useCopy } from '../../shared/copy/useCopy';
import { readHandoverReach, type CashLoan } from '../../shared/exit/getCash';
import type { Role } from '../../shared/positions/loanView';
import { useOwnRead } from '../../shared/reads/useOwnRead';

interface LoanStatementProps {
  role: Role;
  durationDays: bigint;
  fullTermInterest: boolean;
  chain: SupportedChain;
  loan: CashLoan;
}

/**
 * #3763 §6.1 — what the loan is, said to each side it is read by, in the
 * variant every loan takes today: it does not renew (renewal is not built,
 * so no loan says it renews and no page offers to stop renewals). The
 * lender's statement names the handover to another lender only where it can
 * happen for this loan: the takeover is deployed, the loan was opened
 * through the instant market, and it takes interest by time.
 */
export function LoanStatement({ role, durationDays, fullTermInterest, chain, loan }: LoanStatementProps) {
  const { text, format } = useCopy();
  const reach = useOwnRead(['position', 'handoverReach', loan.loanId.toString()], (c) => readHandoverReach(c, chain.diamondAddress, loan), { enabled: role.lender === true });
  const days = durationDays.toString();
  const handover = reach.data === 'yes';
  return (
    <section className="loan-statement" aria-labelledby="loan-statement-title" data-testid="position-statement">
      <h3 id="loan-statement-title">{text('position.statementTitle')}</h3>
      {role.lender === true && (
        <p className="tier-a" data-testid="position-statement-lender" data-handover={handover ? 'yes' : 'no'}>
          {format(handover ? 'position.statementLenderHandover' : 'position.statementLender', { days })}
        </p>
      )}
      {role.borrower === true && (
        <p className="tier-a" data-testid="position-statement-borrower">
          {format(fullTermInterest ? 'position.statementBorrowerFullTerm' : 'position.statementBorrower', { days })}
        </p>
      )}
    </section>
  );
}
