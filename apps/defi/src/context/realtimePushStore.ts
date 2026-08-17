/**
 * Realtime-push transport state — the context object, its value type, and the
 * consumer hook.
 *
 * Split out of `RealtimePushContext.tsx` so that file exports a component and
 * nothing else; a module mixing a component with plain values makes editing
 * the provider a full reload instead of a hot swap. The socket lifecycle and
 * every design invariant governing it stay in the `.tsx`.
 */
import { createContext, useContext } from 'react';

/** Connection posture surfaced to the UI (orthogonal to data freshness). */
export type RealtimeTransport = 'live' | 'polling' | 'reconnecting';

export interface RealtimePushContextValue {
  /** `live` only when the socket is open AND the DO reports ingest active. */
  transport: RealtimeTransport;
  /** UNIX-ms of the last invalidation frame received, or `null`. */
  lastEventAt: number | null;
  /** #843 delta 2 — how many times a LIVE socket has dropped and reconnected
   *  (diagnostics only). Initial connects + intentional ingest-off closes don't
   *  count — only the loss of an established live channel. */
  reconnectCount: number;
}

export const RealtimePushContext = createContext<RealtimePushContextValue | null>(null);

/** Read the realtime push transport state. Safe outside the provider — returns
 *  a static `polling` posture so callers never need a null guard. */
export function useRealtimePush(): RealtimePushContextValue {
  const ctx = useContext(RealtimePushContext);
  return ctx ?? { transport: 'polling', lastEventAt: null, reconnectCount: 0 };
}
