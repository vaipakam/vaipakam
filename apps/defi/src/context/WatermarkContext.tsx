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
import { usePublicClient } from 'wagmi';
import { type Address } from 'viem';
import { useReadChain } from '../contracts/useDiamond';
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
}

const WatermarkContext = createContext<WatermarkContextValue | null>(null);

// Process-global subscriber id sequence. Provider remount on chain switch
// keeps growing the sequence; collisions are impossible.
let nextSubscriberId = 1;

export function WatermarkProvider({ children }: { children: ReactNode }) {
  const publicClient = usePublicClient();
  const chain = useReadChain();
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

  useEffect(() => {
    if (!publicClient || !diamond) {
      setSnapshot(null);
      setStatus('idle');
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
      return Math.min(...intervals);
    }

    async function probe(): Promise<void> {
      try {
        const result = (await publicClient!.readContract({
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
        const safeBlock = await publicClient!.getBlock({ blockTag: 'safe' });
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
        if (advanced) setVersion((v) => v + 1);
      } catch {
        if (!cancelled) setStatus('unreachable');
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
    };
  }, [publicClient, diamond]);

  const value = useMemo<WatermarkContextValue>(
    () => ({ version, snapshot, status, register, unregister }),
    [version, snapshot, status, register, unregister],
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
