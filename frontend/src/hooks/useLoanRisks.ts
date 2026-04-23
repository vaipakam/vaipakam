import { useEffect, useState } from 'react';
import { useDiamondPublicClient, useReadChain } from '../contracts/useDiamond';
import { DEFAULT_CHAIN } from '../contracts/config';
import { DIAMOND_ABI } from '../contracts/abis';
import { batchCalls, encodeBatchCalls } from '../lib/multicall';
import type { Address } from 'viem';

export interface LoanRisk {
  ltv: bigint | null;
  hf: bigint | null;
}

/**
 * Fetches `calculateLTV` + `calculateHealthFactor` for a list of loan IDs in
 * two Multicall3 round-trips total — independent of list length. Consumers
 * (the Dashboard "Your Loans" table) render from the returned map instead of
 * each row firing its own two RPCs. Re-runs only when the set of IDs
 * changes (stringified bigint list), so paging and mode toggles don't
 * re-fetch already-visible rows.
 */
export function useLoanRisks(loanIds: bigint[]) {
  const publicClient = useDiamondPublicClient();
  const chain = useReadChain();
  const [risks, setRisks] = useState<Map<string, LoanRisk>>(new Map());
  const [loading, setLoading] = useState(false);

  const diamondAddress = (chain.diamondAddress ?? DEFAULT_CHAIN.diamondAddress) as Address;

  // Stable signature for the dependency array — comparing bigint arrays by
  // reference re-fires the effect on every render.
  const idsKey = loanIds.map((id) => id.toString()).join(',');

  useEffect(() => {
    if (loanIds.length === 0) {
      setRisks(new Map());
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const argsList = loanIds.map((id) => [id] as const);
        const ltvCalls = encodeBatchCalls(
          diamondAddress,
          DIAMOND_ABI,
          'calculateLTV',
          argsList,
        );
        const hfCalls = encodeBatchCalls(
          diamondAddress,
          DIAMOND_ABI,
          'calculateHealthFactor',
          argsList,
        );
        const [ltvs, hfs] = await Promise.all([
          batchCalls<bigint>(publicClient, DIAMOND_ABI, 'calculateLTV', ltvCalls),
          batchCalls<bigint>(publicClient, DIAMOND_ABI, 'calculateHealthFactor', hfCalls),
        ]);
        if (cancelled) return;
        const next = new Map<string, LoanRisk>();
        for (let i = 0; i < loanIds.length; i++) {
          next.set(loanIds[i].toString(), {
            ltv: ltvs[i] ?? null,
            hf: hfs[i] ?? null,
          });
        }
        setRisks(next);
      } catch {
        if (!cancelled) setRisks(new Map());
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, diamondAddress, publicClient]);

  return { risks, loading };
}
