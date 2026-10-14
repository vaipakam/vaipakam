/**
 * The minute clock that replaces the Worker's `* * * * *` cron trigger.
 *
 * It fires on each UTC minute boundary and passes that boundary as the tick's
 * scheduled time, which is what the cron delivers as `scheduledTime`, so every
 * pass's `% n` cadence lands on the same minutes it would on a Worker.
 *
 * One rule a Worker does not need: ticks never overlap. Every pass signs with
 * the same keeper key, and passes keep per-tick state in memory (the
 * liquidator's attempted set is cleared at the start of each tick), so a tick
 * that started while the previous one was still running could attempt the
 * same loan twice. A minute whose previous tick is still running is skipped,
 * and the skip is logged with the passes still in flight, so a pass that has
 * stopped finishing is visible rather than silently starving the rest.
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
  /** Runs one tick, launching each due pass through `launch`. */
  runTick(
    scheduledTimeMs: number,
    launch: (passName: string, run: Promise<void>) => void,
  ): Promise<void>;
  log(line: string): void;
}

export interface TickRunner {
  /** Starts the tick for `scheduledTimeMs`; false when one is still running. */
  fire(scheduledTimeMs: number): boolean;
  /** Resolves when no tick is running. */
  idle(): Promise<void>;
  /** Pass names still running, for the skip line and shutdown. */
  inFlight(): string[];
}

export function createTickRunner(deps: TickRunnerDeps): TickRunner {
  let current: Promise<void> | null = null;
  const running = new Map<string, number>();

  const fire = (scheduledTimeMs: number): boolean => {
    if (current !== null) {
      const names = [...running.keys()];
      deps.log(
        `[keeper-host] tick ${new Date(scheduledTimeMs).toISOString()} skipped: the previous tick is still running (${names.join(', ') || 'launching'})`,
      );
      return false;
    }
    const launched: Promise<void>[] = [];
    const launch = (passName: string, run: Promise<void>) => {
      running.set(passName, (running.get(passName) ?? 0) + 1);
      launched.push(
        run.finally(() => {
          const n = (running.get(passName) ?? 1) - 1;
          if (n <= 0) running.delete(passName);
          else running.set(passName, n);
        }),
      );
    };
    current = (async () => {
      try {
        await deps.runTick(scheduledTimeMs, launch);
      } catch (err) {
        deps.log(`[keeper-host] tick ${new Date(scheduledTimeMs).toISOString()} failed: ${String(err)}`);
      }
      // Passes are wrapped so they never reject; allSettled is belt and braces.
      await Promise.allSettled(launched);
    })().finally(() => {
      current = null;
    });
    return true;
  };

  return {
    fire,
    idle: async () => {
      while (current !== null) await current;
    },
    inFlight: () => [...running.keys()],
  };
}
