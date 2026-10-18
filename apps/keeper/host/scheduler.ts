/**
 * The minute clock that replaces the Worker's `* * * * *` cron trigger.
 *
 * It fires on each UTC minute boundary and passes that boundary as the tick's
 * scheduled time, which is what the cron delivers as `scheduledTime`, so every
 * pass's `% n` cadence lands on the same minutes it would on a Worker.
 *
 * One rule a Worker does not need: a PASS never overlaps ITSELF. Passes keep
 * per-run state in memory (the liquidator's attempted set is cleared at the
 * start of each run), so a second run started while the first is still going
 * could attempt the same loan twice. A due pass whose previous run is still in
 * flight is therefore not launched, and that is logged by name, so a pass that
 * has stopped finishing is visible.
 *
 * Every OTHER due pass launches on time (#2497 r9). This used to skip the whole
 * minute while any pass of the previous tick was running, so one slow pass —
 * the hourly sanctions pass waiting on receipts, say — held back the
 * minute-cadence liquidator and acknowledgement passes for as long as it ran.
 * Overlapping DIFFERENT passes is safe for the nonce: every send goes through
 * the per-key submission queue (`src/submissionQueue.ts`), which orders sends
 * across passes and across ticks in this process.
 *
 * A minute is skipped outright only while the previous tick is still
 * LAUNCHING (the lease claim, the gates, secret resolution).
 *
 * THE LEASE IS RENEWED BY THE HOST, NOT BY A TICK GETTING THROUGH (#2497 r13).
 * Every minute on which a pass is still in flight, or the previous tick is
 * still launching, calls `onSkip` (the host's one-runner lease renewal,
 * #2503), whatever the new tick then does. A tick renews only once it passes
 * the gates, so a run of declined ticks would otherwise let the lease lapse
 * while a long pass is still sending, and another runner could take it and
 * sign alongside.
 */

export const MINUTE_MS = 60_000;

/** The minute boundary at or before `nowMs`. */
export function minuteFloor(nowMs: number): number {
  return nowMs - (nowMs % MINUTE_MS);
}

/** Milliseconds from `nowMs` to the next minute boundary (never 0). */
export function msUntilNextMinute(nowMs: number): number {
  return MINUTE_MS - (nowMs % MINUTE_MS);
}

export interface TickRunnerDeps {
  /** Runs one tick, handing each due pass to `launch` as a thunk. */
  runTick(
    scheduledTimeMs: number,
    launch: (passName: string, run: () => Promise<void>) => void,
  ): Promise<void>;
  log(line: string): void;
  /** Called every minute on which a pass is still in flight or the previous
   *  tick is still launching — the host renews the one-runner lease here.
   *  Must not reject. */
  onSkip?(scheduledTimeMs: number): Promise<void>;
}

export interface TickRunner {
  /** Starts the tick for `scheduledTimeMs`; false when the previous one is still launching. */
  fire(scheduledTimeMs: number): boolean;
  /** Resolves when no tick is launching and no pass is running. */
  idle(): Promise<void>;
  /** Pass names still running, for the log and shutdown. */
  inFlight(): string[];
}

export function createTickRunner(deps: TickRunnerDeps): TickRunner {
  let launching: Promise<void> | null = null;
  const running = new Map<string, Promise<void>>();

  const fire = (scheduledTimeMs: number): boolean => {
    const at = new Date(scheduledTimeMs).toISOString();
    // Anything still running: keep the lease, whatever this minute's tick does.
    if (launching !== null || running.size > 0) void deps.onSkip?.(scheduledTimeMs);
    if (launching !== null) {
      deps.log(`[keeper-host] tick ${at} skipped: the previous tick is still launching its passes`);
      return false;
    }
    const launch = (passName: string, run: () => Promise<void>) => {
      if (running.has(passName)) {
        deps.log(`[keeper-host] ${passName} not launched at ${at}: its previous run is still in flight`);
        return;
      }
      // Passes are wrapped so they never reject; the catch is belt and braces.
      const p = Promise.resolve()
        .then(run)
        .catch((err) => deps.log(`[keeper-host] ${passName} failed: ${String(err)}`))
        .finally(() => {
          if (running.get(passName) === p) running.delete(passName);
        });
      running.set(passName, p);
    };
    launching = (async () => {
      try {
        await deps.runTick(scheduledTimeMs, launch);
      } catch (err) {
        deps.log(`[keeper-host] tick ${at} failed: ${String(err)}`);
      }
    })().finally(() => {
      launching = null;
    });
    return true;
  };

  return {
    fire,
    idle: async () => {
      while (launching !== null || running.size > 0) {
        await Promise.allSettled([launching, ...running.values()]);
      }
    },
    inFlight: () => [...running.keys()],
  };
}
