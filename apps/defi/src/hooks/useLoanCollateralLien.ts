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

  /**
   * Inner read. Accepts an `isCancelled` predicate so the caller (the
   * effect, or the `reload` callback) can suppress every state write once
   * the loanId has moved on. React Router reuses this component across
   * loan ids, so an in-flight `getLoanCollateralLien` can resolve AFTER
   * the new loan rendered — without the guard it would publish the
   * previous loan's collateral record as proof against the new loan.
   */
  const load = useCallback(
    async (isCancelled: () => boolean = () => false) => {
      if (!loanId) return;
      // Clear the previous loan's lien up front so a stale record doesn't
      // linger in the card while the new read is in flight.
      if (!isCancelled()) {
        setLien(null);
        setError(null);
        setLoading(true);
      }
      if (!diamond) {
        // Chain has no Diamond — leave lien=null; the page renders the
        // unsupported-chain banner. Without this gate the call against
        // ZERO_ADDRESS throws AbiDecodingZeroDataError on mount.
        if (!isCancelled()) setLoading(false);
        return;
      }
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
        if (!isCancelled()) setLien(data);
        step.success();
      } catch (err) {
        if (!isCancelled()) {
          setError('Collateral lien failed to load.');
          setLien(null);
        }
        step.failure(err);
      } finally {
        if (!isCancelled()) setLoading(false);
      }
    },
    [loanId, diamond],
  );

  useEffect(() => {
    let cancelled = false;
    load(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [load]);

  return { lien, loading, error, reload: load };
}
