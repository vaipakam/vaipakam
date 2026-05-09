import { useEffect, useState, useCallback } from 'react';
import { useDiamondRead } from '../contracts/useDiamond';
import { type LoanDetails } from '../types/loan';
import { beginStep } from '../lib/journeyLog';

/**
 * Loads a single loan plus the current holders of its lender/borrower NFTs.
 * Holders are tracked separately from `loan.lender` / `loan.borrower` because
 * claim and repayment rights follow the NFT, not the original participants.
 *
 * Strategic flows (Preclose Option 3 offset, EarlyWithdrawal sale) now lock
 * the position NFT in place rather than depositing it into escrow, so
 * `ownerOf` resolves directly to the initiating user throughout the flow.
 */
export function useLoan(loanId: string | undefined) {
  const diamond = useDiamondRead();
  const [loan, setLoan] = useState<LoanDetails | null>(null);
  const [lenderHolder, setLenderHolder] = useState<string>('');
  const [borrowerHolder, setBorrowerHolder] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!loanId) return;
    setLoading(true);
    setError(null);
    const step = beginStep({ area: 'loan-view', flow: 'getLoanDetails', step: 'read', loanId });
    try {
      const data = (await diamond.getLoanDetails(BigInt(loanId))) as LoanDetails;
      setLoan(data);
      // Holders may not exist yet (NFT burned / not minted) — fail soft.
      try { setLenderHolder(await diamond.ownerOf(data.lenderTokenId)); } catch { setLenderHolder(''); }
      try { setBorrowerHolder(await diamond.ownerOf(data.borrowerTokenId)); } catch { setBorrowerHolder(''); }
      step.success();
    } catch (err) {
      setError('Loan not found or failed to load.');
      setLoan(null);
      step.failure(err);
    } finally {
      setLoading(false);
    }
  }, [loanId, diamond]);

  useEffect(() => { load(); }, [load]);

  return { loan, lenderHolder, borrowerHolder, loading, error, reload: load };
}
