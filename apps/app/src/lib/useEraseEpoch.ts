/**
 * React binding for the erase epoch — see `eraseEpoch.ts` for why it
 * exists. Split from the store so the store itself stays importable
 * from non-React code and testable without a renderer.
 */
import { useSyncExternalStore } from 'react';
import { getEraseEpoch, subscribeEraseEpoch } from './eraseEpoch';

/** Re-renders the caller whenever local data is erased. Use it as an
 *  extra dependency wherever a component re-reads browser storage. */
export function useEraseEpoch(): number {
  return useSyncExternalStore(subscribeEraseEpoch, getEraseEpoch, getEraseEpoch);
}
