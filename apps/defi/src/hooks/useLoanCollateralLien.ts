import { useEffect, useState, useCallback } from 'react';
import { useReadyDiamond } from '../contracts/useDiamond';
import { type Encumbrance } from '../types/encumbrance';
import { beginStep } from '../lib/journeyLog';

/**
 * Loads the on-chain collateral lien (`Encumbrance`) backing a single loan.
 *
 * Reads `MetricsFacet.getLoanCollateralLien(loanId)` — the record that
 * tells a lender their collateral is provably locked in the borrower's
 * vault, and tells a borrower their deposit is encumbered until the loan
 * closes. Mirrors {@link useLoan}'s no-Diamond gating: on a chain without a
 * deployed Diamond the hook leaves `lien=null` rather than calling against
 * ZERO_ADDRESS and throwing on every mount.
 *
 * #564 D.1 — LoanDetails collateral-lien card.
 */
export function useLoanCollateralLien(loanId: string | undefined) {
  const diamond = useReadyDiamond();
  const [lien, setLien] = useState<Encumbrance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!loanId) return;
    if (!diamond) {
      // Chain has no Diamond — leave lien=null; the page renders the
      // unsupported-chain banner. Without this gate the call against
      // ZERO_ADDRESS throws AbiDecodingZeroDataError on mount.
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const step = beginStep({
      area: 'loan-view',
      flow: 'getLoanCollateralLien',
      step: 'read',
      loanId,
    });
    try {
      const data = (await diamond.getLoanCollateralLien(
        BigInt(loanId),
      )) as Encumbrance;
      setLien(data);
      step.success();
    } catch (err) {
      setError('Collateral lien failed to load.');
      setLien(null);
      step.failure(err);
    } finally {
      setLoading(false);
    }
  }, [loanId, diamond]);

  useEffect(() => {
    load();
  }, [load]);

  return { lien, loading, error, reload: load };
}
