import { useEffect, useState, useCallback, useRef } from 'react';
import { useReadyDiamond } from '../contracts/useDiamond';

/**
 * Full keeper-execution status for both sides of a loan.
 *
 * LibAuth gates keeper actions on three flags per side — loan-level opt-in,
 * the user's profile opt-in, and the keeper being on the user's whitelist
 * (see LibAuth.requireLenderNFTOwnerOrKeeper / requireBorrowerNFTOwnerOrKeeper).
 *
 * Per README §3 lines 190–191 authority is ownership-sensitive: it follows
 * the current `ownerOf(tokenId)` of the position NFT, not the latched
 * `loan.lender` / `loan.borrower`. Callers MUST pass the current NFT
 * holders (as resolved by `useLoan` via `ownerOf`), otherwise a mid-flow
 * NFT transfer would cause the UI to read profile opt-in + whitelist for
 * the former owner and drift from on-chain authority.
 *
 * Whitelist contents aren't returned — we only need the count to distinguish
 * "nobody approved" from "at least one keeper approved."
 */
export interface SideKeeperStatus {
  profileOptIn: boolean;
  approvedCount: number;
}

export function useKeeperStatus(
  lenderHolder: string | null | undefined,
  borrowerHolder: string | null | undefined,
) {
  const diamond = useReadyDiamond();
  // #811 r5 — stale-resolve guard, now the RESULT'S OWN TAG rather than a ref
  // plus a clearing effect. `LoanDetails` is reused across `/loans/:id`
  // navigations, so a slow read for the PREVIOUS loan's holders can resolve
  // after the new loan has loaded; without a guard that late response would
  // overwrite state with a different address's keeper status, and the caller
  // would render an inert-cap warning keyed on the wrong wallet.
  //
  // The ref stays — it is what stops a superseded read COMMITTING — but the
  // clearing effect it was paired with is gone. That effect existed to "drop
  // any prior loan's status the moment the holders change", which is right,
  // except that an effect runs AFTER the paint it was meant to prevent: the
  // previous loan's keeper state was on screen for exactly one frame under the
  // new loan's heading. Deriving the answer from the tag removes the frame
  // instead of shortening it. Same half-fix, and the same correction, as
  // `useOfferChildLoans` and `useLoan`.
  const reqKey =
    lenderHolder && borrowerHolder && diamond
      ? `${lenderHolder.toLowerCase()}:${borrowerHolder.toLowerCase()}`
      : null;
  const [result, setResult] = useState<{
    key: string;
    lenderStatus: SideKeeperStatus | null;
    borrowerStatus: SideKeeperStatus | null;
    keepersPaused: boolean | null;
    error: string | null;
  } | null>(null);
  const [refreshingKey, setRefreshingKey] = useState<string | null>(null);
  const reqKeyRef = useRef('');

  const load = useCallback(async () => {
    if (!lenderHolder || !borrowerHolder) return;
    if (!diamond) return; // chain has no Diamond — bail before zero-address read
    const key = `${lenderHolder.toLowerCase()}:${borrowerHolder.toLowerCase()}`;
    reqKeyRef.current = key;
    setRefreshingKey(key);
    try {
      const [lOpt, bOpt, lList, bList, paused] = await Promise.all([
        diamond.getKeeperAccess(lenderHolder) as Promise<boolean>,
        diamond.getKeeperAccess(borrowerHolder) as Promise<boolean>,
        diamond.getApprovedKeepers(lenderHolder) as Promise<string[]>,
        diamond.getApprovedKeepers(borrowerHolder) as Promise<string[]>,
        (diamond as unknown as { keepersPaused: () => Promise<boolean> })
          .keepersPaused() as Promise<boolean>,
      ]);
      if (reqKeyRef.current !== key) return; // a newer read superseded this one
      setResult({
        key,
        lenderStatus: { profileOptIn: lOpt, approvedCount: lList.length },
        borrowerStatus: { profileOptIn: bOpt, approvedCount: bList.length },
        keepersPaused: Boolean(paused),
        error: null,
      });
    } catch (err) {
      if (reqKeyRef.current !== key) return;
      setResult({
        key,
        lenderStatus: null,
        borrowerStatus: null,
        keepersPaused: null,
        error: err instanceof Error ? err.message : 'Keeper status read failed',
      });
    } finally {
      setRefreshingKey((k) => (k === key ? null : k));
    }
  }, [lenderHolder, borrowerHolder, diamond]);

  useEffect(() => {
    void load();
  }, [load]);

  const matched = result?.key === reqKey;
  return {
    lenderStatus: matched ? result.lenderStatus : null,
    borrowerStatus: matched ? result.borrowerStatus : null,
    keepersPaused: matched ? result.keepersPaused : null,
    // An explicit `reload()` reports loading even though the question has not
    // changed; it is called from handlers, never from an effect.
    loading: reqKey !== null && (refreshingKey === reqKey || !matched),
    error: matched ? result.error : null,
    reload: load,
  };
}
