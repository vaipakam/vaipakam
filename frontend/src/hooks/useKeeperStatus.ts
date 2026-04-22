import { useEffect, useState, useCallback } from 'react';
import { useDiamondRead } from '../contracts/useDiamond';

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
  const diamond = useDiamondRead();
  const [lenderStatus, setLenderStatus] = useState<SideKeeperStatus | null>(null);
  const [borrowerStatus, setBorrowerStatus] = useState<SideKeeperStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!lenderHolder || !borrowerHolder) return;
    setLoading(true);
    setError(null);
    try {
      const [lOpt, bOpt, lList, bList] = await Promise.all([
        diamond.getKeeperAccess(lenderHolder) as Promise<boolean>,
        diamond.getKeeperAccess(borrowerHolder) as Promise<boolean>,
        diamond.getApprovedKeepers(lenderHolder) as Promise<string[]>,
        diamond.getApprovedKeepers(borrowerHolder) as Promise<string[]>,
      ]);
      setLenderStatus({ profileOptIn: lOpt, approvedCount: lList.length });
      setBorrowerStatus({ profileOptIn: bOpt, approvedCount: bList.length });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Keeper status read failed');
      setLenderStatus(null);
      setBorrowerStatus(null);
    } finally {
      setLoading(false);
    }
  }, [lenderHolder, borrowerHolder, diamond]);

  useEffect(() => { load(); }, [load]);

  return { lenderStatus, borrowerStatus, loading, error, reload: load };
}
