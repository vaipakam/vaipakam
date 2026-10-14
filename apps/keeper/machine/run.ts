/**
 * The keeper's long-lived machine runner — the off-Workers host
 * (docs/DesignsAndPlans/KeeperHostPortability.md).
 *
 * Every minute, on the UTC minute boundary, it resolves the env through the
 * SAME `resolveEnv` the Worker uses and runs the SAME tick (`runKeeperTick`),
 * passing the minute the tick is FOR as `scheduledTimeMs`, so each pass's
 * cadence (`cadenceSkipReason`) behaves exactly as under the Worker's cron.
 *
 * Two properties are structural, not configured:
 *   - NO OVERLAP. The loop awaits a tick's passes before it looks for the next
 *     minute; a tick that overruns makes the minutes it covered SKIP, logged by
 *     count. Two ticks never run at once, so no two passes share a nonce race
 *     of their own making.
 *   - CLEAN STOP. SIGTERM / SIGINT stop new ticks; the in-flight tick finishes,
 *     then the process exits 0. A pass is never cut off mid-submission by the
 *     runner itself.
 *
 *   node --env-file=.env.machine dist/keeper-machine.mjs     (bundled)
 *   pnpm --filter @vaipakam/keeper run machine              (tsx, for a dev host)
 *
 * (Entry: machine/main.ts, which only calls `main()` — this module stays
 * importable by tests without starting a loop.)
 *
 * ONE RUNNER AT A TIME is not yet enforced in code: until the lease in the
 * design lands, the Worker's schedule must be EMPTY (it is, since #1896) while
 * a machine runs. The runbook (docs/ops/KeeperMachine.md) states the order.
 */
import { resolveEnv } from '../src/env';
import { runKeeperTick } from '../src/tick';
import { rawEnvFromProcess, type ProcessEnv } from './envFromProcess';

const MINUTE = 60_000;

export interface LoopDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Run the tick for this scheduled minute; resolves when its passes do. */
  tick(scheduledTimeMs: number): Promise<void>;
  log(line: string): void;
  /** True once a stop was requested. */
  stopping(): boolean;
}

/** The next whole UTC minute strictly after `t`. */
export function nextMinute(t: number): number {
  return Math.floor(t / MINUTE) * MINUTE + MINUTE;
}

/**
 * Tick on every minute boundary until a stop is requested. Pure over its
 * deps, so the schedule and the overrun rule are tested without a clock.
 */
export async function runLoop(deps: LoopDeps): Promise<void> {
  let due = nextMinute(deps.now());
  while (!deps.stopping()) {
    const wait = due - deps.now();
    if (wait > 0) await deps.sleep(wait);
    if (deps.stopping()) break;
    try {
      await deps.tick(due);
    } catch (err) {
      // The tick isolates each pass; this catches only a failure BEFORE the
      // passes (an env that would not resolve, say). Logged, and the next
      // minute tries again — the same contract as a failed Worker invocation.
      deps.log(`[keeper-machine] tick for ${new Date(due).toISOString()} failed before its passes: ${String((err as Error)?.message ?? err)}`);
    }
    const after = nextMinute(deps.now());
    const missed = Math.round((after - due) / MINUTE) - 1;
    if (missed > 0) {
      deps.log(`[keeper-machine] the tick for ${new Date(due).toISOString()} overran: skipped ${missed} minute(s), never overlapped`);
    }
    due = after;
  }
  deps.log('[keeper-machine] stopped: no tick in flight');
}

/** One tick against the real env: resolve, run, await every pass. */
export async function machineTick(env: ProcessEnv, scheduledTimeMs: number): Promise<void> {
  const resolved = await resolveEnv(rawEnvFromProcess(env));
  const work: Promise<void>[] = [];
  runKeeperTick(resolved, { scheduledTimeMs, defer: (p) => work.push(p) });
  await Promise.all(work);
}

export async function main(): Promise<void> {
  let stop = false;
  const requestStop = (sig: string) => {
    if (!stop) console.log(`[keeper-machine] ${sig}: finishing the tick in flight, then exiting`);
    stop = true;
  };
  process.on('SIGTERM', () => requestStop('SIGTERM'));
  process.on('SIGINT', () => requestStop('SIGINT'));
  // Fail at START, not at the first minute, when a required variable is
  // missing or the database cannot be reached with the credentials given.
  const probe = rawEnvFromProcess(process.env).DB as unknown as { prepare(sql: string): { first(): Promise<unknown> } };
  await probe.prepare('SELECT 1 AS ok').first();
  console.log('[keeper-machine] database reachable');
  console.log('[keeper-machine] started; ticking on each UTC minute');
  await runLoop({
    now: () => Date.now(),
    sleep: (ms) =>
      new Promise((resolve) => {
        // Wake early on a stop request so shutdown is not delayed a minute.
        const started = Date.now();
        const poll = setInterval(() => {
          if (stop || Date.now() - started >= ms) {
            clearInterval(poll);
            resolve();
          }
        }, Math.min(ms, 1_000));
      }),
    tick: (t) => machineTick(process.env, t),
    log: (line) => console.log(line),
    stopping: () => stop,
  });
  process.exit(0);
}
