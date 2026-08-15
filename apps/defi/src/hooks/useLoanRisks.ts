import { useEffect, useState } from 'react';
import { useDiamondPublicClient, useReadChain } from '../contracts/useDiamond';
import { DEFAULT_CHAIN } from '../contracts/config';
import { DIAMOND_ABI_VIEM as DIAMOND_ABI } from '@vaipakam/contracts/abis';
import { batchCalls, encodeBatchCalls } from '@vaipakam/lib/multicall';
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
/** Shared empty map so an unresolved read returns a stable identity rather
 *  than a fresh `Map` every render. */
const EMPTY_RISKS: ReadonlyMap<string, LoanRisk> = new Map();

export function useLoanRisks(loanIds: bigint[]) {
  const publicClient = useDiamondPublicClient();
  const chain = useReadChain();
  const diamondAddress = (chain.diamondAddress ?? DEFAULT_CHAIN.diamondAddress) as Address;

  // Stable signature for the dependency array — comparing bigint arrays by
  // reference re-fires the effect on every render.
  const idsKey = loanIds.map((id) => id.toString()).join(',');
  // …and the same signature identifies the ANSWER. LTV and health factor are
  // per-chain, per-loan quantities: a map computed for one Diamond keyed only
  // by loan id would read as valid against another, and health factor is what
  // the row colours and the liquidation warning are drawn from.
  const reqKey = loanIds.length === 0 ? null : `${chain.chainId}|${diamondAddress}|${idsKey}`;
  const [result, setResult] = useState<{ key: string; risks: Map<string, LoanRisk> } | null>(
    null,
  );

  useEffect(() => {
    if (!reqKey) return;
    let cancelled = false;
    (async () => {
      let next = new Map<string, LoanRisk>();
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
        for (let i = 0; i < loanIds.length; i++) {
          next.set(loanIds[i].toString(), {
            ltv: ltvs[i] ?? null,
            hf: hfs[i] ?? null,
          });
        }
      } catch {
        next = new Map();
      }
      if (cancelled) return;
      setResult({ key: reqKey, risks: next });
    })();
    return () => {
      cancelled = true;
      // Dropped on the way out, so the same id set re-requested after a gap
      // reads as loading rather than as the figures from before it.
      setResult(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reqKey, idsKey, diamondAddress, publicClient]);

  const matched = result?.key === reqKey;
  return {
    risks: matched ? result.risks : EMPTY_RISKS,
    loading: reqKey !== null && !matched,
  };
}
