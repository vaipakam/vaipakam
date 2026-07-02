import { useEffect, useState } from 'react';
import type { Address } from 'viem';
import { checkSanctioned } from '@vaipakam/defi-client';
import { useDiamondPublicClient, useReadChain } from './useDiamond';

export function useSanctionsCheck(who: string | null | undefined) {
  const publicClient = useDiamondPublicClient();
  const chain = useReadChain();
  const [state, setState] = useState({
    loading: false,
    isSanctioned: false,
    unverified: false,
    error: null as string | null,
  });

  useEffect(() => {
    if (!who || !chain.diamondAddress) {
      setState({ loading: false, isSanctioned: false, unverified: false, error: null });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null, unverified: false }));
    void checkSanctioned(publicClient, chain.diamondAddress as Address, who as Address)
      .then((flagged) => {
        if (!cancelled) {
          setState({ loading: false, isSanctioned: flagged, unverified: false, error: null });
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setState({
            loading: false,
            isSanctioned: false,
            unverified: true,
            error: e instanceof Error ? e.message : 'Sanctions check failed',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [who, chain.diamondAddress, publicClient]);

  return state;
}