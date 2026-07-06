/**
 * Live chain sync — turns each new block into a refresh of the
 * transaction-driven query caches, so the UI reflects on-chain
 * changes (the user's own tx AND everyone else's) within seconds
 * instead of on the 30s interval poll.
 *
 * PUSH-ONLY BY DESIGN (RPC diet): the block watcher mounts ONLY when
 * the active chain has a WebSocket RPC configured (`wagmi.ts` wraps it
 * in a `fallback` ahead of HTTP, so viem subscribes via
 * `eth_subscribe('newHeads')` — zero request cost per block). Without
 * a WS URL this component renders nothing at all: the earlier shape
 * fell back to HTTP block-polling here, and the live measurement on
 * production (#RPC-diet) showed what that costs — the watcher burned
 * an `eth_blockNumber` every ~1.2s and its invalidations dragged the
 * whole live query set (indexer pages + the catch-up's `eth_getLogs`)
 * from the nominal 30s cadence down to ~5s, ~3,700 RPC calls/hour per
 * open tab, wallet or not. On HTTP-only deploys the 30s interval
 * refetch (plus synchronous invalidation at every write call site,
 * and the indexer push channel) carries freshness instead.
 *
 * Also fully off while the tab is hidden — previously only the
 * invalidation callback early-returned, which stopped the refetches
 * but left the transport's block subscription running.
 *
 * Only the TRANSACTION-driven keys are invalidated (see LIVE_KEYS) —
 * static config (protocol fees, tier tables, token metadata, curated
 * lists) is left alone so a fast block cadence doesn't churn reads
 * that never move per block. Invalidations are throttled so a burst
 * of blocks can't storm the indexer.
 *
 * Renders nothing; mount once inside the app shell.
 */
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useWatchBlockNumber } from 'wagmi';
import { isIdle, onActivityResume } from '../lib/idle';
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
  // 'loanKeeperEnabled' and 'vpfi' are DELIBERATELY absent: their
  // toggle writes PATCH the cache with the mined value (read-after-
  // write honesty — public testnet RPCs serve pre-tx state for
  // seconds), and a block-driven refetch inside that window would
  // overwrite the patch with stale state and bounce the checkbox.
  // Both are own-wallet state that third parties don't move; their
  // 30s/60s interval refetch reconciles once the RPC caught up. (The
  // idle-RESUME refresh below DOES cover them — after 2 min without
  // interaction no own-write patch can still be in that window.)
]);

/** Extra roots the idle-RESUME refresh covers beyond LIVE_KEYS:
 *  own-wallet reads that feed form gates (balance / Max / over-max)
 *  but are deliberately NOT block-invalidated — under WS push they'd
 *  refetch every floor tick for data only the user's own (cache-
 *  patched) actions usually move. On resume they must be fresh
 *  immediately, though: a stretched idle timer may still be in
 *  flight (Codex round-2 P2).
 *
 *  'vpfi' / 'loanKeeperEnabled' are safe HERE even though LIVE_KEYS
 *  excludes them for read-after-write honesty: the resume path only
 *  fires after ≥2 min without interaction, so no own write (writes
 *  require interaction) can still be inside the public-RPC stale
 *  window — the refetch reconciles, it can't clobber a fresh cache
 *  patch (Codex round-3 P2: stale VPFI free balance could gate the
 *  first post-idle withdraw for another stretched tick). */
const RESUME_EXTRA_KEYS: ReadonlySet<string> = new Set([
  'tokenBalance',
  'vpfi',
  'loanKeeperEnabled',
]);

/** Floor between block-driven invalidations. Base Sepolia mines ~every
 *  2s; each invalidation refetches the mounted live set, which
 *  includes indexer pages AND the book catch-up's `eth_getLogs`, so
 *  the floor is what the third-party-freshness feature actually costs
 *  per unit time. 12s keeps "someone else's action shows up in
 *  seconds" while cutting that recurring cost 3× vs the previous 4s —
 *  the user's OWN actions refresh their keys synchronously at the
 *  call site regardless of this throttle. */
const MIN_INVALIDATE_MS = 12_000;

/** Page visibility as a React-subscribable store — gates the watcher
 *  itself (not just the callback) so a hidden tab holds no block
 *  subscription at all. */
function subscribeVisibility(onChange: () => void): () => void {
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}
function usePageVisible(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => !document.hidden,
    () => true,
  );
}

export function LiveChainSync() {
  const { readChain } = useActiveChain();
  const queryClient = useQueryClient();
  const lastAt = useRef(0);
  const visible = usePageVisible();

  const invalidate = useCallback(
    (extra?: ReadonlySet<string>) => {
      void queryClient.invalidateQueries({
        // Only refetch mounted queries; unmounted ones are just marked
        // stale and refetch when their screen next opens.
        refetchType: 'active',
        predicate: (query) => {
          const root = query.queryKey[0];
          return (
            typeof root === 'string' &&
            (LIVE_KEYS.has(root) || (extra?.has(root) ?? false))
          );
        },
      });
    },
    [queryClient],
  );

  const onBlockNumber = useCallback(() => {
    // Idle sessions don't consume push freshness either — otherwise a
    // WS deploy would keep refetching the live set (indexer pages +
    // the catch-up's log scan) at the floor cadence for a parked tab,
    // bypassing the idle backoff (Codex round-2 P2). The resume path
    // below catches the tab up the moment the user is back.
    if (isIdle()) return;
    const now = Date.now();
    if (now - lastAt.current < MIN_INVALIDATE_MS) return;
    lastAt.current = now;
    invalidate();
  }, [invalidate]);

  // Idle→active resume: a stretched idle-cadence timer already in
  // flight runs to completion regardless of new input (TanStack only
  // re-evaluates a function refetchInterval after a fetch), so the
  // first interaction after an idle stretch refreshes the
  // transaction-driven caches directly. Refetching also reschedules
  // those queries' intervals back at the active cadence. Bypasses the
  // block throttle (it IS the freshness catch-up) but stamps it, so a
  // block arriving right after can't double-fire.
  useEffect(
    () =>
      onActivityResume(() => {
        lastAt.current = Date.now();
        invalidate(RESUME_EXTRA_KEYS);
      }),
    [invalidate],
  );

  useWatchBlockNumber({
    chainId: readChain.chainId,
    // Push transports only, and only while the tab is visible. On an
    // HTTP-only deploy this hook never subscribes — see the header
    // for why the polling fallback was removed.
    enabled: Boolean(readChain.wsUrl) && visible,
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
