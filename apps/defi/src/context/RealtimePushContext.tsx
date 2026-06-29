/**
 * #757 Phase B — realtime push provider.
 *
 * Opens ONE WebSocket per active chain to the indexer's per-chain ingest
 * Durable Object (`GET /ws/chain/:chainId`). After each scan's D1 write the DO
 * pushes a typed invalidation frame; we map it to an immediate watermark
 * `nudge()` so the existing data hooks refetch the changed slice within seconds
 * instead of waiting for their next poll.
 *
 * DESIGN INVARIANTS:
 *   - **Additive, never load-bearing.** The push carries a SIGNAL only (which
 *     slice changed), never authoritative data — the refetch goes through the
 *     existing REST/RPC surface, so the trust model is unchanged. The watermark
 *     poll keeps running underneath at its normal cadence; if the socket never
 *     connects, drops, or the deployment has no DO, the UI is exactly as fresh
 *     as it was pre-Phase-B. We do NOT suppress polling in v1 (that adaptive
 *     back-off is a follow-up) — correctness first.
 *   - **Honest transport state.** A connected-but-silent socket (DO ingest
 *     disabled) is reported as `polling`, never a false `live`, so the badge
 *     can't claim realtime it isn't getting. Only a `hello` with
 *     `ingestActive: true` flips us to `live`.
 *   - **Cheap when idle.** Bursts of frames coalesce into one debounced nudge.
 *     A channel that's unavailable here (503/426, or ingest off) backs off to a
 *     long retry rather than hammering.
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useReadChain } from '../contracts/useDiamond';
import { useWatermarkContext } from './WatermarkContext';
import { indexerWsOrigin } from '../lib/indexerClient';

/** Connection posture surfaced to the UI (orthogonal to data freshness). */
export type RealtimeTransport = 'live' | 'polling' | 'reconnecting';

interface RealtimePushContextValue {
  /** `live` only when the socket is open AND the DO reports ingest active. */
  transport: RealtimeTransport;
  /** UNIX-ms of the last invalidation frame received, or `null`. */
  lastEventAt: number | null;
}

const RealtimePushContext = createContext<RealtimePushContextValue | null>(null);

/** Server→client push frames (mirror of `chainIngestDO.ts:PushFrame`). */
type ServerFrame =
  | { t: 'hello'; chainId: number | null; ingestActive: boolean }
  | { t: 'invalidate'; chainId: number; keys: string[]; scannedTo: string };

/** Debounce window for coalescing a burst of invalidation frames into one nudge. */
const NUDGE_DEBOUNCE_MS = 300;
/** Base reconnect backoff; doubles per attempt up to the cap. */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_CAP_MS = 30_000;
/** After this many connects that never went live, treat the channel as absent
 *  on this deployment and retry only occasionally (operator may enable later). */
const GIVE_UP_AFTER = 6;
const DORMANT_RETRY_MS = 300_000; // 5 min

export function RealtimePushProvider({ children }: { children: ReactNode }) {
  const chain = useReadChain();
  const chainId = chain.chainId;
  const { nudge } = useWatermarkContext();
  const wsOrigin = indexerWsOrigin();

  const [transport, setTransport] = useState<RealtimeTransport>('polling');
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);

  // Keep the latest `nudge` reachable from the long-lived effect without
  // re-running it (re-running would tear down and rebuild the socket).
  const nudgeRef = useRef(nudge);
  useEffect(() => {
    nudgeRef.current = nudge;
  }, [nudge]);

  useEffect(() => {
    if (!wsOrigin || !chainId) {
      setTransport('polling');
      return;
    }

    let cancelled = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let nudgeTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let everLive = false;
    // Set when a reconnect learns the channel is INTENTIONALLY inactive
    // (`hello.ingestActive === false` — DO ingest rolled back). The next
    // `onclose` then schedules a dormant retry and reports honest `polling`
    // instead of latching `reconnecting` forever off the stale `everLive`.
    let intentionalInactive = false;
    // When a frame arrives in a hidden/background tab we DON'T nudge (which
    // would bypass the watermark's own `document.hidden` pause and drive RPC +
    // refetches from a parked tab). Remember it and flush once on focus.
    let hiddenDirty = false;

    const scheduleNudge = () => {
      if (typeof document !== 'undefined' && document.hidden) {
        hiddenDirty = true;
        return;
      }
      if (nudgeTimer) return; // already pending — coalesce
      nudgeTimer = setTimeout(() => {
        nudgeTimer = null;
        if (!cancelled) nudgeRef.current();
      }, NUDGE_DEBOUNCE_MS);
    };

    const onVisibility = () => {
      if (cancelled) return;
      if (!document.hidden && hiddenDirty) {
        hiddenDirty = false;
        scheduleNudge(); // one coalesced refetch for everything missed while hidden
      }
    };

    const scheduleReconnect = () => {
      if (cancelled || reconnectTimer) return;
      // Go DORMANT (long retry + honest `polling`) when either:
      //   - the channel is intentionally inactive (hello said ingest is off), or
      //   - we've tried `GIVE_UP_AFTER` times without (re)reaching live — covers
      //     both "never available here" AND "was live, then rolled back / the
      //     route now 503s", so a previously-live tab can't churn `reconnecting`
      //     at 30s forever. A brief blip reconnects well under that bound and
      //     stays `reconnecting`.
      const dormant = intentionalInactive || attempt >= GIVE_UP_AFTER;
      intentionalInactive = false; // consumed
      const delay = dormant
        ? DORMANT_RETRY_MS
        : Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** attempt);
      setTransport(dormant ? 'polling' : everLive ? 'reconnecting' : 'polling');
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    };

    const connect = () => {
      if (cancelled) return;
      attempt += 1;
      let socket: WebSocket;
      try {
        socket = new WebSocket(`${wsOrigin}/ws/chain/${chainId}`);
      } catch {
        scheduleReconnect();
        return;
      }
      ws = socket;

      socket.onmessage = (ev) => {
        if (cancelled) return;
        let frame: ServerFrame;
        try {
          frame = JSON.parse(String(ev.data)) as ServerFrame;
        } catch {
          return; // ignore malformed frames
        }
        if (frame.t === 'hello') {
          if (frame.ingestActive) {
            everLive = true;
            attempt = 0; // healthy channel — reset backoff
            setTransport('live');
          } else {
            // Channel reachable but DO ingest is off — no pushes will come.
            // Reset the live latch and flag an intentional-inactive close so the
            // following `onclose` goes dormant + reports honest `polling` (not
            // `reconnecting` off the now-stale `everLive`).
            everLive = false;
            intentionalInactive = true;
            setTransport('polling');
            try {
              socket.close(1000);
            } catch {
              /* already closing */
            }
          }
        } else if (frame.t === 'invalidate') {
          setLastEventAt(Date.now());
          scheduleNudge();
        }
      };

      socket.onclose = () => {
        if (cancelled) return;
        ws = null;
        scheduleReconnect();
      };
      socket.onerror = () => {
        // `onclose` always follows `onerror`; let it drive the reconnect so we
        // don't double-schedule.
      };
    };

    connect();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (nudgeTimer) clearTimeout(nudgeTimer);
      if (ws) {
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        try {
          ws.close(1000);
        } catch {
          /* already closing */
        }
      }
    };
  }, [wsOrigin, chainId]);

  const value = useMemo<RealtimePushContextValue>(
    () => ({ transport, lastEventAt }),
    [transport, lastEventAt],
  );

  return (
    <RealtimePushContext.Provider value={value}>
      {children}
    </RealtimePushContext.Provider>
  );
}

/** Read the realtime push transport state. Safe outside the provider — returns
 *  a static `polling` posture so callers never need a null guard. */
export function useRealtimePush(): RealtimePushContextValue {
  const ctx = useContext(RealtimePushContext);
  return ctx ?? { transport: 'polling', lastEventAt: null };
}
