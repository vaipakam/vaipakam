/**
 * Live chain sync — turns each new block into an immediate refresh of
 * the transaction-driven query caches, so the UI reflects on-chain
 * changes (the user's own tx AND everyone else's) within a block
 * instead of on the 30s indexer poll.
 *
 * Transport-adaptive by construction: when a chain has a WebSocket RPC
 * configured (`wagmi.ts` wraps it in a `fallback` ahead of HTTP),
 * viem's block watcher uses `eth_subscribe('newHeads')` — a true push,
 * so reflection is near-instant. Without a WS URL it falls back to
 * HTTP block polling (viem's default ~4s cadence), still far tighter
 * than the 30s poll. Either way this component is the single place that
 * fans a new block out to the caches.
 *
 * Only the TRANSACTION-driven keys are invalidated (see LIVE_KEYS) —
 * static config (protocol fees, tier tables, token metadata, curated
 * lists) is left alone so a fast block cadence doesn't churn reads that
 * never move per block. Invalidations are throttled and pause while the
 * tab is hidden, so a burst of blocks or a backgrounded tab can't storm
 * the indexer.
 *
 * Renders nothing; mount once inside the app shell.
 */
import { useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useWatchBlockNumber } from 'wagmi';
import { useActiveChain } from './useActiveChain';

/** queryKey[0] values that move when a transaction lands. Everything
 *  else (protocolFees, tokenMeta, curatedTokens, tier tables, buffers,
 *  grace seconds, nftRentalSupport, legLiquidity) is config-ish and
 *  intentionally excluded from per-block refresh. */
const LIVE_KEYS: ReadonlySet<string> = new Set([
  'activeOffers',
  'activity',
  'myOffers',
  'offer',
  'offerLinkedLoan',
  'myLoans',
  'loan',
  'loanLive',
  'loanLiveStatus',
  'loanRisk',
  'positionOwners',
  'claimables',
  'vaultAssets',
  'loanSalePending',
  'refinancePending',
  'standingApprovals',
  'keeperConfig',
  'loanKeeperEnabled',
  'vpfi',
]);

/** Floor between block-driven invalidations. Base Sepolia mines ~every
 *  2s, so an unthrottled WS push would refetch the whole live set that
 *  often; 4s halves that while still feeling immediate. A user's own
 *  action refreshes its keys synchronously at the call site regardless
 *  of this throttle. */
const MIN_INVALIDATE_MS = 4_000;

export function LiveChainSync() {
  const { readChain } = useActiveChain();
  const queryClient = useQueryClient();
  const lastAt = useRef(0);

  const onBlockNumber = useCallback(() => {
    // A backgrounded tab shouldn't drive indexer traffic; react-query
    // refetches active queries on remount/focus anyway.
    if (typeof document !== 'undefined' && document.hidden) return;
    const now = Date.now();
    if (now - lastAt.current < MIN_INVALIDATE_MS) return;
    lastAt.current = now;
    void queryClient.invalidateQueries({
      // Only refetch mounted queries; unmounted ones are just marked
      // stale and refetch when their screen next opens.
      refetchType: 'active',
      predicate: (query) => {
        const root = query.queryKey[0];
        return typeof root === 'string' && LIVE_KEYS.has(root);
      },
    });
  }, [queryClient]);

  useWatchBlockNumber({
    chainId: readChain.chainId,
    // `poll` is intentionally unset: viem uses eth_subscribe on a WS
    // transport and polls on HTTP — the graceful degrade we want.
    onBlockNumber,
    onError: (err) => {
      // A transient subscription drop must not crash the tree; the
      // fallback HTTP transport keeps reads working and the watcher
      // re-subscribes on the next render.
      console.warn('LiveChainSync: block watch error', err);
    },
  });

  return null;
}
