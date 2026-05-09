import { useEffect, useState } from 'react';
import { type Address } from 'viem';
import {
  useDiamondPublicClient,
  useReadChain,
} from '../contracts/useDiamond';
import { DIAMOND_ABI_VIEM } from '../contracts/abis';

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

  const [state, setState] = useState<SanctionsState>({
    isSanctioned: false,
    loading: false,
    error: null,
    checkedAddress: null,
  });

  useEffect(() => {
    if (!who || !diamondAddress) {
      setState({
        isSanctioned: false,
        loading: false,
        error: null,
        checkedAddress: null,
      });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    (async () => {
      try {
        const flagged = (await publicClient.readContract({
          address: diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'isSanctionedAddress',
          args: [who],
        })) as boolean;
        if (cancelled) return;
        setState({
          isSanctioned: Boolean(flagged),
          loading: false,
          error: null,
          checkedAddress: who,
        });
      } catch (e) {
        if (cancelled) return;
        setState({
          isSanctioned: false,
          loading: false,
          error: (e as Error)?.message ?? 'Sanctions check failed',
          checkedAddress: who,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, diamondAddress, who]);

  return state;
}
