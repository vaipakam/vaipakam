import { useEffect, useMemo, useState } from 'react';
import { type Address } from 'viem';
import {
  useDiamondPublicClient,
  useReadChain,
} from '../contracts/useDiamond';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';

/**
 * Pre-flight sanctions check for a given address.
 *
 * Reads `ProfileFacet.isSanctionedAddress(who)` off the current chain's
 * Diamond. The underlying on-chain check delegates to the
 * Chainalysis-style oracle configured by governance. When no oracle is
 * configured (some chains, especially L2 testnets), the check is a
 * no-op and this hook returns `{ isSanctioned: false }` — which is the
 * intentional fail-open behaviour.
 *
 * Intended usage: gate the "submit" button on Create Offer / Accept
 * Offer / Refinance / similar flows. Preview the answer to the user
 * BEFORE they sign so they get a clear message instead of a raw
 * on-chain revert.
 */
export interface SanctionsState {
  /** True if the Chainalysis oracle reports the address sanctioned. */
  isSanctioned: boolean;
  /** True while the initial read is in flight. */
  loading: boolean;
  /** Non-null when the Diamond read itself failed (e.g. unsupported chain). */
  error: string | null;
  /** The address that was checked — mirrors the input for UI clarity. */
  checkedAddress: Address | null;
}

export function useSanctionsCheck(
  who: Address | null | undefined,
): SanctionsState {
  const publicClient = useDiamondPublicClient();
  const chain = useReadChain();
  const diamondAddress = chain.diamondAddress as Address | null;

  // Tagged with the exact question asked — chain and address. Both the
  // disabled answer and the in-flight answer are DERIVED, not written from the
  // effect, so there is no frame in which one address's verdict is displayed
  // under another's. That matters more here than on a cosmetic read: the
  // previous address's `isSanctioned: false` sitting against a newly connected
  // wallet is a clean bill of health for an address nobody checked.
  const reqKey = who && diamondAddress ? `${chain.chainId}|${who.toLowerCase()}` : null;
  const [result, setResult] = useState<{
    key: string;
    isSanctioned: boolean;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    if (!reqKey || !who || !diamondAddress) return;
    let cancelled = false;
    (async () => {
      let next: { isSanctioned: boolean; error: string | null };
      try {
        const flagged = (await publicClient.readContract({
          address: diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'isSanctionedAddress',
          args: [who],
        })) as boolean;
        next = { isSanctioned: Boolean(flagged), error: null };
      } catch (e) {
        next = {
          isSanctioned: false,
          error: (e as Error)?.message ?? 'Sanctions check failed',
        };
      }
      if (cancelled) return;
      setResult({ key: reqKey, ...next });
    })();
    return () => {
      cancelled = true;
      // Dropped on the way out — re-asking the same question after a gap must
      // read as loading, not as the answer from before the gap.
      setResult(null);
    };
  }, [publicClient, diamondAddress, who, reqKey]);

  // Memoized so consumers that put this object in a dependency array don't
  // re-run on every render of their parent.
  return useMemo<SanctionsState>(() => {
    if (!reqKey || !who) {
      return { isSanctioned: false, loading: false, error: null, checkedAddress: null };
    }
    if (result?.key !== reqKey) {
      // In flight. `isSanctioned: false` while loading is the pre-existing
      // contract — callers gate on `loading` — and is unchanged here.
      return { isSanctioned: false, loading: true, error: null, checkedAddress: who };
    }
    return {
      isSanctioned: result.isSanctioned,
      loading: false,
      error: result.error,
      checkedAddress: who,
    };
  }, [reqKey, who, result]);
}
