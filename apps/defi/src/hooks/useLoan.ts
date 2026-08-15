import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useReadChain, useReadyDiamond } from '../contracts/useDiamond';
import { type LoanDetails } from '../types/loan';
import { beginStep } from '../lib/journeyLog';

/**
 * Loads a single loan plus the current holders of its lender/borrower NFTs.
 * Holders are tracked separately from `loan.lender` / `loan.borrower` because
 * claim and repayment rights follow the NFT, not the original participants.
 *
 * Strategic flows (Preclose Option 3 offset, EarlyWithdrawal sale) now lock
 * the position NFT in place rather than depositing it into vault, so
 * `ownerOf` resolves directly to the initiating user throughout the flow.
 */
export function useLoan(loanId: string | undefined) {
  const diamond = useReadyDiamond();
  const chainId = useReadChain().chainId;
  // The request key is the whole question — which Diamond, which loan. The
  // answer is tagged with it and `loading` is DERIVED, so a detail page
  // navigated from loan 7 to loan 8 cannot render loan 7's parties, amounts and
  // status under loan 8's heading while the read is in flight. The previous
  // shape wrote `loading` from the effect, which lands a paint after the one
  // that showed the wrong loan.
  // CHAIN is part of the identity. A loan id means a different loan on a
  // different deployment, so keying on the id alone let the previous chain's
  // parties, amounts and status match for a render — and, worse, let a slow
  // read from the old chain overwrite the new chain's result later, since its
  // key matched too. Loan ids are small integers, so the collision is the
  // normal case rather than a corner one.
  const reqKey = loanId && diamond ? `${chainId}|${loanId}` : null;
  const [result, setResult] = useState<{
    key: string;
    loan: LoanDetails | null;
    lenderHolder: string;
    borrowerHolder: string;
    error: string | null;
  } | null>(null);
  // The key that an EXPLICIT reload is currently refreshing, or null. Scoped
  // rather than a bare boolean: a reload started on chain A that is still in
  // flight when the user moves to chain B was pinning every `useLoan` page in
  // its full-page loading state until that unrelated RPC settled — a stalled
  // one indefinitely.
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  // The question currently being asked, readable from an async continuation.
  // A key check at RENDER time is not enough on its own: both completion paths
  // committed unconditionally, so a slow chain-A read landing after chain B's
  // had already resolved replaced B's result with an A-keyed one — and since no
  // B read remained, the page stayed loading forever. Guarding the render and
  // not the COMMIT leaves the worse of the two failures in place.
  //
  // `useLayoutEffect`, not a render-phase write: mutating a ref during render
  // is unsafe under concurrent rendering, which is the rule #1747 was about.
  const activeKey = useRef(reqKey);
  useLayoutEffect(() => {
    activeKey.current = reqKey;
  }, [reqKey]);

  const load = useCallback(async () => {
    if (!loanId) return;
    if (!diamond) {
      // Chain has no Diamond — leave loan=null; the page renders the
      // unsupported-chain banner. Without this gate the call against
      // ZERO_ADDRESS throws AbiDecodingZeroDataError on every detail-page
      // mount until the user connects/switches.
      return;
    }
    const key = `${chainId}|${loanId}`;
    const step = beginStep({ area: 'loan-view', flow: 'getLoanDetails', step: 'read', loanId });
    try {
      const data = (await diamond.getLoanDetails(BigInt(loanId))) as LoanDetails;
      // Holders may not exist yet (NFT burned / not minted) — fail soft.
      let lenderHolder = '';
      let borrowerHolder = '';
      try { lenderHolder = await diamond.ownerOf(data.lenderTokenId); } catch { lenderHolder = ''; }
      try { borrowerHolder = await diamond.ownerOf(data.borrowerTokenId); } catch { borrowerHolder = ''; }
      if (key === activeKey.current) {
        setResult({ key, loan: data, lenderHolder, borrowerHolder, error: null });
      }
      // The read genuinely happened, so the journey log records it either way;
      // only the COMMIT is conditional.
      step.success();
    } catch (err) {
      if (key === activeKey.current) {
        setResult({
          key,
          loan: null,
          lenderHolder: '',
          borrowerHolder: '',
          error: 'Loan not found or failed to load.',
        });
      }
      step.failure(err);
    }
  }, [loanId, diamond, chainId]);

  const reload = useCallback(async () => {
    const key = activeKey.current;
    setPendingKey(key);
    try {
      await load();
    } finally {
      // Clear only if this reload is still the one being awaited — a newer
      // question must not have its pending state cleared by an older refresh.
      setPendingKey((k) => (k === key ? null : k));
    }
  }, [load]);

  useEffect(() => {
    void load();
    return () => {
      // Dropped on the way out, so returning to a loan already viewed re-reads
      // rather than showing the copy from the previous visit — a loan's status
      // and outstanding amount are exactly the fields that move underneath it.
      setResult(null);
    };
  }, [load]);

  const matched = result?.key === reqKey;
  // An EXPLICIT reload has no key change to derive `loading` from — the
  // question is identical, only the answer is meant to be newer. Without this,
  // the post-transaction refreshes in `LoanDetails` (repay, add-collateral)
  // left the pre-transaction figures and their action controls live until the
  // RPC returned, because the local action flag clears first. `reload` is only
  // ever called from an event handler, so setting state in it is not the
  // cascade the effect rule is about.
  const loading = (reqKey !== null && pendingKey === reqKey) || (reqKey !== null && !matched);
  return {
    loan: matched ? result.loan : null,
    lenderHolder: matched ? result.lenderHolder : '',
    borrowerHolder: matched ? result.borrowerHolder : '',
    // No Diamond on this chain is not "loading" — it is a settled answer the
    // page renders its unsupported-chain banner for.
    loading,
    error: matched ? result.error : null,
    reload,
  };
}
