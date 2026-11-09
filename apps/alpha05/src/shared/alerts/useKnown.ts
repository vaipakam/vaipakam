import { useCallback, useSyncExternalStore } from 'react';
import { knownSnapshot, subscribeKnown, type KnownAlerts } from './known';

type Hex = `0x${string}`;

/** What this browser has done with a wallet's alerts on one network, kept
 *  current: a write from any card, a late answer, or another tab shows here. */
export function useKnown(chainId: number, wallet: Hex): KnownAlerts {
  const snapshot = useCallback(() => knownSnapshot(chainId, wallet), [chainId, wallet]);
  return useSyncExternalStore(subscribeKnown, snapshot, snapshot);
}
