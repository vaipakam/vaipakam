/**
 * Live-watermark context — the context object, its value type, and the
 * consumer hook.
 *
 * Split out of `WatermarkContext.tsx` so that file exports a component and
 * nothing else; a module mixing a component with plain values makes editing
 * the provider a full reload instead of a hot swap. The probe scheduler, the
 * subscriber registry and the push-backed cadence logic all stay in the
 * `.tsx` — this file is the shape they publish.
 */
import { createContext, useContext } from 'react';
import {
  type UseLiveWatermarkOptions,
  type WatermarkSnapshot,
  type WatermarkStatus,
} from '../hooks/watermarkInternals';

/**
 * #843 delta 2 — realtime-poll diagnostics, exposed via a STABLE ref so reads
 * don't churn the hot context value (every watermark subscriber reads it). The
 * provider mutates `.current` imperatively each schedule / push-driven probe;
 * the diagnostics drawer polls it on a tick while open.
 */
export interface WatermarkDiagnostics {
  /** The cadence (ms) the next probe is armed at, after the push-backed floor;
   *  `null` when no timer is armed (no subscribers / all paused / tab hidden). */
  effectivePollIntervalMs: number | null;
  /** Whether the push-backed floor is currently relaxing the cadence. */
  pushBacked: boolean;
  /** Duration (ms) of the most recent push-nudge-driven probe (event→refetch
   *  settle), or `null` if no push-driven probe has run. */
  lastNudgeLatencyMs: number | null;
}

export interface WatermarkContextValue {
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
   * #843 delta 1 — the realtime push provider calls this when its transport
   * flips. While push is healthy (`true`) the poll cadence relaxes to the
   * push-backed floor (`pushBackedInterval`); `false` restores the tier cadence
   * immediately (an in-flight timer is rescheduled). Stable identity.
   */
  setPushHealthy: (healthy: boolean) => void;
  /** #843 delta 2 — stable ref of realtime-poll diagnostics (see type). */
  diagnosticsRef: { readonly current: WatermarkDiagnostics };
  /**
   * #757 Phase B — fire an immediate probe and FORCE a `version` bump, even
   * when the lifetime counters didn't move. The realtime WS push calls this
   * when the indexer signals a state change: status-only mutations (repay,
   * default, cancel, transfer) don't advance `getGlobalCounts`, so the normal
   * advance-gated bump would miss them — `nudge()` guarantees subscribers
   * refetch. Also refreshes `snapshot.safeBlock` first so the refetch's RPC
   * catch-up window includes the just-confirmed block. Coalesce bursts at the
   * call site (the WS client debounces).
   *
   * #845 Codex P3 — `eventAt` (UNIX-ms of the invalidation frame that triggered
   * the nudge) lets the diagnostics drawer report "Push→refetch latency" from
   * the frame's ARRIVAL rather than the probe's start, so the debounce window
   * and any wait behind an in-flight probe are included. Omitted (push-agnostic
   * callers) → the probe is measured from its own start, as before.
   */
  nudge: (eventAt?: number) => void;
}

export const WatermarkContext = createContext<WatermarkContextValue | null>(null);

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
