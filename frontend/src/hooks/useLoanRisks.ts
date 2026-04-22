import { useEffect, useMemo, useState } from 'react';
import { Interface } from 'ethers';
import { useDiamondRead, useReadChain } from '../contracts/useDiamond';
import { DEFAULT_CHAIN } from '../contracts/config';
import { DIAMOND_ABI } from '../contracts/abis';
import { batchCalls } from '../lib/multicall';

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
  const diamond = useDiamondRead();
  const chain = useReadChain();
  const [risks, setRisks] = useState<Map<string, LoanRisk>>(new Map());
  const [loading, setLoading] = useState(false);

  const iface = useMemo(() => new Interface(DIAMOND_ABI), []);
  const diamondAddress = chain.diamondAddress ?? DEFAULT_CHAIN.diamondAddress!;

  // Stable signature for the dependency array — comparing bigint arrays by
  // reference re-fires the effect on every render.
  const idsKey = loanIds.map((id) => id.toString()).join(',');

  useEffect(() => {
    if (loanIds.length === 0) {
      setRisks(new Map());
      return;
    }
    let cancelled = false;
    const provider = diamond.runner?.provider;
    if (!provider) return;
    setLoading(true);
    (async () => {
      try {
        const ltvCalls = loanIds.map((id) => ({
          target: diamondAddress,
          callData: iface.encodeFunctionData('calculateLTV', [id]),
        }));
        const hfCalls = loanIds.map((id) => ({
          target: diamondAddress,
          callData: iface.encodeFunctionData('calculateHealthFactor', [id]),
        }));
        const [ltvs, hfs] = await Promise.all([
          batchCalls<bigint>(provider, iface, 'calculateLTV', ltvCalls),
          batchCalls<bigint>(provider, iface, 'calculateHealthFactor', hfCalls),
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
  }, [idsKey, diamondAddress, diamond, iface]);

  return { risks, loading };
}
