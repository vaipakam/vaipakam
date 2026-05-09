import { useCallback, useEffect, useState } from 'react';
import type { Address } from 'viem';
import { useDiamondPublicClient, useReadChain } from '../contracts/useDiamond';
import { DEFAULT_CHAIN } from '../contracts/config';
import { DIAMOND_ABI_VIEM as DIAMOND_ABI } from '../contracts/abis';

/** Side of a loan an interaction-reward entry belongs to. Mirrors the
 *  on-chain `LibVaipakam.RewardSide` enum (Lender = 0, Borrower = 1). */
export type RewardSide = 'lender' | 'borrower';

/** One contributing-loan row per (user, loan, side). The full struct
 *  the contract returns includes `processed` / `forfeited` lifecycle
 *  flags, but the UI only consumes the fields below. */
export interface InteractionRewardEntry {
  loanId: bigint;
  side: RewardSide;
  /** Snapshot of the loan's interest accrual rate in 18-decimal
   *  numeraire-units per day (USD by post-deploy default; whatever
   *  governance has rotated to otherwise). Frontends multiply by
   *  `(endDay || today) - startDay` to show the lifetime contribution
   *  per loan. */
  perDayNumeraire18: bigint;
  startDay: number;
  /** 0 = still open. */
  endDay: number;
  processed: boolean;
  forfeited: boolean;
}

/**
 * Reads `getUserRewardEntries(address)` and decodes the returned
 * `RewardEntry[]` into a frontend-friendly shape. Used to render the
 * "Contributing loans" expandable list under the interaction-rewards
 * claim card on Claim Center. Falls back to an empty array on revert
 * (e.g. older Diamond deploy without the view wired in).
 */
export function useInteractionRewardEntries(address: string | null | undefined) {
  const publicClient = useDiamondPublicClient();
  const chain = useReadChain();
  const diamondAddress = (chain.diamondAddress ?? DEFAULT_CHAIN.diamondAddress) as Address;
  const [entries, setEntries] = useState<InteractionRewardEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!address) {
      setEntries([]);
      return;
    }
    setLoading(true);
    try {
      const raw = (await publicClient.readContract({
        address: diamondAddress,
        abi: DIAMOND_ABI,
        functionName: 'getUserRewardEntries',
        args: [address as Address],
      })) as ReadonlyArray<{
        user: string;
        loanId: bigint;
        startDay: number;
        endDay: number;
        side: number;
        processed: boolean;
        forfeited: boolean;
        perDayNumeraire18: bigint;
      }>;
      setEntries(
        raw.map((e) => ({
          loanId: e.loanId,
          side: Number(e.side) === 0 ? 'lender' : 'borrower',
          perDayNumeraire18: e.perDayNumeraire18,
          startDay: Number(e.startDay),
          endDay: Number(e.endDay),
          processed: e.processed,
          forfeited: e.forfeited,
        })),
      );
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [address, publicClient, diamondAddress]);

  useEffect(() => { load(); }, [load]);

  return { entries, loading, reload: load };
}
