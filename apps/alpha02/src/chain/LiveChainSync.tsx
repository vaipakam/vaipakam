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
import {
  blockDeliveryFresh,
  blockEverDelivered,
  isRailHealthy,
  railBlockSignal,
  railBlockWatchReset,
} from './railHealth';
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
  // #1131/#1145 round-5 — the crossable band's chain reads (previewMatch
  // + previewMatchRiskBlock share this root). A partial fill or cancel
  // flips a previously-Ok preview without any own-wallet action, and the
  // push KEY_MAP deliberately excludes chain-read caches (its unit test
  // pins previewMatch as "LiveChainSync territory") — so WS deploys
  // refresh it per block here; HTTP-only deploys keep the 30s interval,
  // and the band's execute() re-reads live before the write either way.
  'deskPreviewMatch',
  // RPC read-diet PR A (Codex #1228 r2 P1) — the split ghost-strip
  // must stay block-driven in the FALLBACK blanket too: with the rail
  // down (or legacy pinned) the strip would otherwise only re-run on
  // its interval, losing the old inline catch-up's block cadence.
  'bookGhostStrip',
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

/** RPC read-diet PR A (design §4.1.2) — the ACTION-GATING subset that
 *  keeps per-block tip freshness while the indexer push rail is
 *  healthy: roots that gate money-moving actions or render
 *  action-decisive detail state, where foreign-block staleness could
 *  mislead an imminent decision. Everything else in LIVE_KEYS
 *  (lists, activity, vault, approvals, config) rides push + receipt +
 *  focus + the 180s net instead — that blanket was the dominant
 *  recurring RPC cost. Each of these roots mounts only on its
 *  specific surface, so the tip-driven cost is bounded to the page
 *  actually being viewed. When the rail is DOWN, the full LIVE_KEYS
 *  blanket returns (today's behaviour, the honest fallback). */
const TIP_KEYS: ReadonlySet<string> = new Set([
  // Detail-page cluster — owner/role/status gates on PositionDetails.
  'loanLive',
  'loanLiveStatus',
  'loanRisk',
  'positionOwners',
  'offer',
  'loan',
  'offerLinkedLoan',
  // Pending-card accept gates.
  'loanSalePending',
  'refinancePending',
  // Past-due/grace banner terms (Codex #1228 r1 P3): tipAware-
  // stretched on PositionDetails, so the tip nudge must cover a keeper
  // extension restamping the terms.
  'graceBannerTerms',
  // Desk crossable band — a stale band shows an executable match that
  // isn't (§4.1.2 / the r5 table split).
  'deskPreviewMatch',
  // Shared-book ghost-strip (§4.1.2a) — its own query root after the
  // split out of useActiveOffers; block-driven so a just-ended offer
  // never outlives the throttle window on the book.
  'bookGhostStrip',
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
  // tipAware-stretched but outside LIVE_KEYS (Codex #1228 r3): a
  // keeper extension restamping terms during an idle stretch must
  // reach the past-due/grace banner on the first interaction —
  // HTTP-only chains have no block nudge to carry it.
  'graceBannerTerms',
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
    (extra?: ReadonlySet<string>, full = false) => {
      // RPC read-diet PR A (§4.1.2): while the indexer push rail is
      // verifiably delivering, the per-block invalidation narrows to
      // the action-gating TIP_KEYS — the lists/vault/activity blanket
      // was the dominant recurring RPC cost, and push + receipt +
      // focus + the 180s net now carry those roots. Rail down (or the
      // VITE_FRESHNESS_TIMERS=legacy hatch) ⇒ the full LIVE_KEYS
      // blanket, byte-for-byte today's behaviour. Evaluated PER
      // invalidation, so a rail transition takes effect on the next
      // block, not the next mount. `full` forces the blanket — the
      // idle-RESUME catch-up is a one-shot "make everything fresh
      // now" for a returning user, not a per-block cost.
      const keys = full || !isRailHealthy() ? LIVE_KEYS : TIP_KEYS;
      void queryClient.invalidateQueries({
        // Only refetch mounted queries; unmounted ones are just marked
        // stale and refetch when their screen next opens.
        refetchType: 'active',
        predicate: (query) => {
          const root = query.queryKey[0];
          return (
            typeof root === 'string' &&
            (keys.has(root) || (extra?.has(root) ?? false))
          );
        },
      });
    },
    [queryClient],
  );

  const onBlockNumber = useCallback(() => {
    // Tip-rail liveness for tipAware (Codex #1228 r1): stamp EVERY
    // delivered block, before the idle/throttle gates - the signal is
    // "the subscription works", not "we refetched".
    railBlockSignal();
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
        invalidate(RESUME_EXTRA_KEYS, /* full */ true);
      }),
    [invalidate],
  );

  // Reset the tip-delivery stamp whenever the watcher's target or
  // gate changes (chain switch, hidden tab, WS config change) — a new
  // subscription must prove delivery itself (Codex #1228 r2).
  useEffect(() => {
    return () => railBlockWatchReset();
  }, [readChain.chainId, readChain.wsUrl, visible]);

  // Block-stall watchdog (Codex #1228 r5): tipAware queries that
  // already armed a 180s timer only re-evaluate after their next
  // fetch, so a subscription that delivered and then silently died
  // would leave action-gating roots with neither the per-block nudge
  // nor the 30s fallback for up to the net window. When delivery ages
  // past the trust window, run ONE catch-up invalidation — it
  // refreshes the tip roots and reschedules their intervals at the
  // restored cadence. Once per stall episode; a fresh block re-arms.
  const stallFired = useRef(false);
  useEffect(() => {
    if (!readChain.wsUrl || !visible) return;
    const timer = setInterval(() => {
      if (blockDeliveryFresh()) {
        stallFired.current = false;
        return;
      }
      if (!blockEverDelivered() || stallFired.current) return;
      stallFired.current = true;
      invalidate();
    }, 15_000);
    return () => clearInterval(timer);
  }, [readChain.wsUrl, visible, invalidate]);

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
