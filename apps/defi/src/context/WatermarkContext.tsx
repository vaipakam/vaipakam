/**
 * Watermark singleton provider.
 *
 * Holds ONE per-(chainId, diamondAddress) probe loop for the lifetime
 * counters (`getGlobalCounts` → `(totalLoansCreated, totalOffersCreated)`).
 * Every `useLiveWatermark()` call site registers as a subscriber and reads
 * the shared `{version, snapshot, status}` — no per-instance timers, no
 * fan-out of `eth_call` + `getBlock({safe})` traffic.
 *
 * The pre-singleton hook design (one timer per `useLiveWatermark` call)
 * scaled to ~16 call sites with several of them rendered on every page
 * (IndexerStatusBadge in AppLayout, useLogIndex / useOfferStats /
 * useIndexedLoans / useIndexedActivity from Dashboard etc.). Each tick was
 * 2 RPC reads, and the timers drifted out of phase, producing a near-
 * continuous network-tab trickle. Centralising to one timer drops typical
 * page traffic from ~12 reads / 30 s to ~2 reads / 30 s.
 *
 * Cadence policy with multiple subscribers:
 *   - The provider takes the **min** of all subscribers' active-tier
 *     pollIntervalMs as the cadence for the next probe. A `hot`
 *     subscriber (5 s) pulls everyone to 5 s; absent that, `warm` (30 s)
 *     wins; absent both, `cool` (180 s) wins. Subscribers that asked for
 *     a faster cadence get it; subscribers that asked for slower get
 *     more probes than they specified, which is harmless (they only
 *     re-render when their `version` advances, and that's still bounded
 *     by the underlying counter advances).
 *   - Activity gating (idle → idleAfterMs → idlePollIntervalMs, paused →
 *     pausedAfterMs → no timer) is evaluated per subscriber on every
 *     reschedule; the provider takes the min of whatever active intervals
 *     each subscriber currently contributes.
 *   - All subscribers contributing `null` (or all in paused-tier) → no
 *     timer at all. The probe still fires on tab-focus and on the
 *     next user-activity event.
 *
 * Reschedule triggers (cancel-current-timer-and-restart):
 *   - subscriber register / unregister (so a new fast subscriber
 *     doesn't wait for the previous slow tick)
 *   - tab visibility return-to-focus
 *   - user activity event after a paused-tier idle
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { type Address } from 'viem';
import { useDiamondPublicClient, useReadChain } from '../contracts/useDiamond';
import {
  WATERMARK_ABI,
  type UseLiveWatermarkOptions,
  type WatermarkSnapshot,
  type WatermarkStatus,
} from '../hooks/watermarkInternals';

interface WatermarkContextValue {
  /** Bumps every time either lifetime counter advances. */
  version: number;
  /** Latest probe result, or `null` until first successful probe. */
  snapshot: WatermarkSnapshot | null;
  /** Probe health. */
  status: WatermarkStatus;
  /** Subscriber registration. Returns an id used by `unregister`. */
  register: (opts: UseLiveWatermarkOptions) => number;
  /** Subscriber deregistration. */
  unregister: (id: number) => void;
  /**
   * #757 Phase B — fire an immediate probe and FORCE a `version` bump, even
   * when the lifetime counters didn't move. The realtime WS push calls this
   * when the indexer signals a state change: status-only mutations (repay,
   * default, cancel, transfer) don't advance `getGlobalCounts`, so the normal
   * advance-gated bump would miss them — `nudge()` guarantees subscribers
   * refetch. Also refreshes `snapshot.safeBlock` first so the refetch's RPC
   * catch-up window includes the just-confirmed block. Coalesce bursts at the
   * call site (the WS client debounces).
   */
  nudge: () => void;
}

const WatermarkContext = createContext<WatermarkContextValue | null>(null);

// Process-global subscriber id sequence. Provider remount on chain switch
// keeps growing the sequence; collisions are impossible.
let nextSubscriberId = 1;

// Cold-chain backoff cadence. When a probe shows the chain has zero
// offers AND zero loans (a freshly-deployed chain, or one nobody has
// touched), there is genuinely nothing for any data hook to display —
// OfferBook is empty, dashboards are empty, claimables are empty. In
// that state we ignore subscriber tiers and probe at this cadence
// instead of burning the hot-tier 5 s heartbeat. The first non-zero
// counter snaps the cadence back to the normal tier-driven min.
//
// 30 s (not the 180 s `cool` tier) because a freshly-deployed chain is
// typically one you're actively testing — you want the first offer to
// surface promptly. 30 s is a 6× cut from the 5 s heartbeat while still
// detecting the cold→warm transition within half a minute. Trade-off:
// another user's FIRST offer on a cold chain surfaces up to ~30 s late;
// the offer's creator sees it immediately via the post-tx receipt
// refetch, and the tab-focus probe still fires one immediate read
// whenever the user comes back to the tab.
const COLD_CHAIN_INTERVAL_MS = 30_000;

export function WatermarkProvider({ children }: { children: ReactNode }) {
  const chain = useReadChain();
  // Canonical app-chain-pinned public client. `useDiamondPublicClient`
  // wraps `usePublicClient({chainId: chain.chainId})` (NOT the bare
  // wagmi hook, which returns the wallet-current client and diverges
  // from the app-selected chain whenever the dropdown is changed
  // without a follow-up wallet prompt) AND ships a transport-only
  // fallback so probes still work before wagmi has a client wired
  // for this chain.
  const publicClient = useDiamondPublicClient();
  const diamond = chain.diamondAddress;

  const subscribersRef = useRef<Map<number, UseLiveWatermarkOptions>>(new Map());
  const [version, setVersion] = useState(0);
  const [snapshot, setSnapshot] = useState<WatermarkSnapshot | null>(null);
  const [status, setStatus] = useState<WatermarkStatus>('idle');

  // Reschedule hook injected by the probe-loop effect. Stays a no-op
  // when no probe loop is active (publicClient/diamond not yet ready,
  // or unmount in flight). Subscribers' register/unregister calls poke
  // through this so a new fast subscriber doesn't wait on the previous
  // slow tick.
  const rescheduleRef = useRef<() => void>(() => {});

  // #757 Phase B — imperative "probe now + force a version bump", injected by
  // the probe-loop effect (closure over the live publicClient/diamond). No-op
  // until a probe loop is active. `nudge()` pokes through this.
  const probeNowRef = useRef<() => void>(() => {});

  const register = useCallback((opts: UseLiveWatermarkOptions) => {
    const id = nextSubscriberId++;
    subscribersRef.current.set(id, opts);
    rescheduleRef.current();
    return id;
  }, []);
  const unregister = useCallback((id: number) => {
    subscribersRef.current.delete(id);
    rescheduleRef.current();
  }, []);
  // Stable identity for consumers (the WS push provider lists it in deps).
  const nudge = useCallback(() => {
    probeNowRef.current();
  }, []);

  useEffect(() => {
    // Chain / diamond switch (or first mount): the prior chain's
    // `safeBlock` + lifetime counters are meaningless on the new chain.
    // Clear them up front so consumers that read `snapshot.safeBlock`
    // — `DataSyncStatus`'s "N blocks behind" gap, the tail-scan upper
    // bounds in `useLogIndex` etc. — don't compute nonsense against a
    // stale cross-chain block height during the window before this
    // chain's first probe lands. (Pre-fix, switching from a high-block
    // chain like Base Sepolia (~41M) to a lower one like Sepolia
    // (~11M) flashed "~30,000,000 blocks behind" until the first
    // probe replaced the snapshot.) `version` is intentionally NOT
    // reset — it's a monotonic change-counter, and the data hooks that
    // key effects on it are already re-keyed on chain/diamond too.
    setSnapshot(null);
    setStatus('idle');
    // useDiamondPublicClient always returns a non-null client (wagmi
    // client OR a transport-only http fallback), so we only need to
    // gate on the diamond address being known for this chain.
    if (!diamond) {
      rescheduleRef.current = () => {};
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const lastProbe: { current: { nextOfferId: bigint; nextLoanId: bigint } | null } = {
      current: null,
    };
    let lastActivityAt = Date.now();
    let lastActivityWriteAt = 0;
    // #757 Phase B — serialize forced (push-nudge) probes. Without this, two
    // nudges arriving while the first `probe()` is still awaiting a slow RPC
    // both reach `.then(schedule())` and arm a second timer without clearing
    // the first — duplicating the singleton poll loop. `forcedInFlight`
    // coalesces concurrent nudges into one trailing re-run.
    let forcedInFlight = false;
    let forcedPending = false;

    // Pick the next cadence by taking the min over all subscribers'
    // currently-effective active interval. Activity gating is per-
    // subscriber: a subscriber whose pausedAfterMs has elapsed contributes
    // nothing; one whose idleAfterMs has elapsed contributes its
    // idlePollIntervalMs (if set, else its full pollIntervalMs).
    function chooseInterval(): number | null {
      const subs = Array.from(subscribersRef.current.values());
      if (subs.length === 0) return null;
      const idle = Date.now() - lastActivityAt;
      const intervals: number[] = [];
      for (const s of subs) {
        if (s.pollIntervalMs == null) continue; // explicit null disables this subscriber's timer demand
        if (s.pausedAfterMs != null && idle >= s.pausedAfterMs) continue;
        if (
          s.idleAfterMs != null &&
          idle >= s.idleAfterMs &&
          s.idlePollIntervalMs != null
        ) {
          intervals.push(s.idlePollIntervalMs);
        } else {
          intervals.push(s.pollIntervalMs);
        }
      }
      if (intervals.length === 0) return null;
      const tierInterval = Math.min(...intervals);
      // Cold-chain backoff: a probe that observed zero offers AND zero
      // loans means there's nothing for any subscriber to display.
      // Stretch the cadence to COLD_CHAIN_INTERVAL_MS regardless of
      // tier until the first counter goes non-zero. lastProbe is null
      // until the first probe completes — until then we use the tier
      // cadence so the initial probe fires promptly.
      const lp = lastProbe.current;
      if (lp && lp.nextOfferId === 0n && lp.nextLoanId === 0n) {
        return Math.max(tierInterval, COLD_CHAIN_INTERVAL_MS);
      }
      return tierInterval;
    }

    async function probe(opts?: { forceBump?: boolean }): Promise<void> {
      try {
        const result = (await publicClient.readContract({
          address: diamond as Address,
          abi: WATERMARK_ABI,
          functionName: 'getGlobalCounts',
          blockTag: 'safe',
        })) as readonly [bigint, bigint];
        if (cancelled) return;
        const [nextLoanId, nextOfferId] = result;
        // Pair the counters with the safe-block they were read at, so
        // subscribers that compute RPC catch-up windows (`safeBlock` as
        // upper bound) don't race against `latest`-tag chain head.
        const safeBlock = await publicClient.getBlock({ blockTag: 'safe' });
        if (cancelled) return;
        const prevCounts = lastProbe.current;
        const advanced =
          prevCounts === null ||
          nextOfferId !== prevCounts.nextOfferId ||
          nextLoanId !== prevCounts.nextLoanId;
        lastProbe.current = { nextOfferId, nextLoanId };
        // Identity-preserve when nothing changed so subscribers using
        // `snapshot` in a useEffect dep don't re-run on every probe.
        setSnapshot((prev) => {
          if (
            prev &&
            prev.nextOfferId === nextOfferId &&
            prev.nextLoanId === nextLoanId &&
            prev.safeBlock === safeBlock.number
          ) {
            return prev;
          }
          return {
            nextOfferId,
            nextLoanId,
            safeBlock: safeBlock.number,
            fetchedAt: Math.floor(Date.now() / 1000),
          };
        });
        setStatus('live');
        // `forceBump` (the Phase B WS nudge) bumps even when the counters held,
        // so a status-only mutation (repay/default/cancel/transfer) still drives
        // subscribers to refetch.
        if (advanced || opts?.forceBump) setVersion((v) => v + 1);
      } catch {
        if (!cancelled) {
          setStatus('unreachable');
          // #757 Phase B (P3) — a forced (push-driven) probe whose `getGlobalCounts`
          // / safe-block read transiently fails STILL bumps `version`. The indexer
          // already wrote D1 and pushed the invalidation; subscribers should
          // refetch the (indexer-backed) slice now rather than wait for the next
          // poll just because the user's RPC hiccupped. Status is separately
          // marked `unreachable`.
          if (opts?.forceBump) setVersion((v) => v + 1);
        }
      }
    }

    function schedule(): void {
      if (cancelled) return;
      if (document.hidden) return; // visibility-pause
      const interval = chooseInterval();
      if (interval === null) return; // no subscribers / all paused
      timer = setTimeout(async () => {
        await probe();
        schedule();
      }, interval);
    }

    // Imperative restart: clear the pending timer and rebuild against
    // the now-current subscriber set + activity state. Bound into
    // rescheduleRef so register/unregister/onActivity can call it.
    rescheduleRef.current = () => {
      if (cancelled) return;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      schedule();
    };

    // #757 Phase B — "probe now + force a version bump". Coalesces concurrent
    // nudges (only ONE forced probe runs at a time; later nudges set
    // `forcedPending` and trigger a single trailing re-run), and always
    // restarts the loop via `rescheduleRef` — which clears any existing timer
    // first — so a burst of push frames can never leave duplicate timers.
    probeNowRef.current = () => {
      if (cancelled) return;
      if (forcedInFlight) {
        forcedPending = true; // fold into the in-flight probe's trailing re-run
        return;
      }
      forcedInFlight = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      void probe({ forceBump: true }).then(() => {
        forcedInFlight = false;
        if (cancelled) return;
        if (forcedPending) {
          forcedPending = false;
          probeNowRef.current(); // absorb nudges that arrived mid-flight
        } else {
          rescheduleRef.current(); // single timer (clears any existing first)
        }
      });
    };

    function onVisibility(): void {
      if (document.hidden) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        return;
      }
      // Re-focused — count as fresh activity and fire an immediate probe.
      lastActivityAt = Date.now();
      void probe().then(() => {
        if (!cancelled) schedule();
      });
    }

    function onActivity(): void {
      const now = Date.now();
      if (now - lastActivityWriteAt < 1_000) return; // 1 Hz throttle
      lastActivityWriteAt = now;
      // "Was paused" check: any subscriber whose pausedAfterMs had
      // already elapsed against the prior activity timestamp.
      const subs = Array.from(subscribersRef.current.values());
      const wasPaused = subs.some(
        (s) => s.pausedAfterMs != null && now - lastActivityAt >= s.pausedAfterMs,
      );
      lastActivityAt = now;
      if (wasPaused && !cancelled && !document.hidden && !timer) {
        void probe().then(() => {
          if (!cancelled && !timer) schedule();
        });
      }
    }

    // Initial fire + schedule.
    void probe().then(() => {
      if (!cancelled) schedule();
    });
    document.addEventListener('visibilitychange', onVisibility);
    const activityOpts = { passive: true } as const;
    document.addEventListener('mousemove', onActivity, activityOpts);
    document.addEventListener('keydown', onActivity, activityOpts);
    document.addEventListener('scroll', onActivity, activityOpts);
    document.addEventListener('touchstart', onActivity, activityOpts);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('mousemove', onActivity);
      document.removeEventListener('keydown', onActivity);
      document.removeEventListener('scroll', onActivity);
      document.removeEventListener('touchstart', onActivity);
      rescheduleRef.current = () => {};
      probeNowRef.current = () => {};
    };
  }, [publicClient, diamond]);

  const value = useMemo<WatermarkContextValue>(
    () => ({ version, snapshot, status, register, unregister, nudge }),
    [version, snapshot, status, register, unregister, nudge],
  );

  return <WatermarkContext.Provider value={value}>{children}</WatermarkContext.Provider>;
}

export function useWatermarkContext(): WatermarkContextValue {
  const ctx = useContext(WatermarkContext);
  if (!ctx) {
    throw new Error(
      'useWatermarkContext must be used inside <WatermarkProvider>. ' +
        'Wrap the app in WatermarkProvider in main.tsx.',
    );
  }
  return ctx;
}
