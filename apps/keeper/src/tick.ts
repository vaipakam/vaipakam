/**
 * ONE keeper tick, independent of the host that schedules it.
 *
 * The Worker's `scheduled()` handler and the long-lived machine runner
 * (`machine/run.ts`, docs/DesignsAndPlans/KeeperHostPortability.md) both call
 * this with a RESOLVED env, so the passes, their cadence and their per-pass
 * isolation are one implementation with two entry points, never a fork.
 *
 * What differs between hosts is only how a pass's promise is kept alive past
 * the call: a Worker hands it to `ctx.waitUntil`; the machine collects it and
 * awaits them all before the next tick. That is the `defer` parameter.
 */
import { getChainConfigs, type Env } from './env';
import { KEEPER_PASSES, cadenceSkipReason } from './passSchedule';

/**
 * Run one pass and report what it cost.
 *
 * The card's acceptance asks for per-pass CPU **attribution** rather
 * than a guess about which pass is expensive, and asks that the numbers
 * be recorded so nobody re-derives them. One line per pass per run is
 * what makes that a read of `wrangler tail` instead of an
 * investigation.
 *
 * This measures WALL time, and the distinction matters for how the
 * numbers are read: a Worker's limit is CPU time, which excludes
 * waiting on I/O, so a pass that spends its time on RPC round-trips
 * will look expensive here and cost little against the limit. Wall time
 * is still the right thing to log — it is available without a profiler,
 * it bounds CPU from above, and a pass that is cheap here cannot be the
 * one blowing the budget. Read it to EXCLUDE suspects; use the
 * dashboard's per-invocation CPU to confirm the culprit.
 */
export async function timedPass(name: string, run: () => Promise<void>): Promise<void> {
  const startedAt = Date.now();
  try {
    await run();
    // eslint-disable-next-line no-console
    console.log(`[keeper] ${name} done in ${Date.now() - startedAt}ms`);
  } catch (err) {
    // Still reports its cost: a pass that fails slowly is a finding,
    // and the old code logged the error without any notion of how long
    // it had been running first.
    // eslint-disable-next-line no-console
    console.error(`[keeper] ${name} pass failed after ${Date.now() - startedAt}ms:`, err);
  }
}

export interface TickOptions {
  /** The tick's SCHEDULED epoch (ms) — the minute it is FOR, not when it
   *  ran — so a late start cannot make a `% n` cadence skip its minute. */
  scheduledTimeMs: number | undefined;
  /** Keep a pass's promise alive past this call (Worker: `ctx.waitUntil`;
   *  machine: collect and await). Each pass is already wrapped by
   *  `timedPass`, so a deferred promise never rejects. */
  defer: (work: Promise<void>) => void;
}

export function runKeeperTick(resolved: Env, { scheduledTimeMs, defer }: TickOptions): void {
  // #1896 — name the RESOLVED chain set, once per tick.
  //
  // A chain drops out silently: `readSecret` collapses an absent binding or
  // a failing Secrets Store fetch to `undefined` (deliberately — see its
  // comment), and `getChainConfigs` then skips any chain with no RPC. The
  // passes log per-chain, so a dropped chain produces NO line at all, and
  // absence is not something an operator can read off a tail.
  //
  // That matters most for the CPU validation this Worker is unscheduled
  // for: a tick can end `ok` purely because it ran against fewer chains
  // than production will once the binding recovers, and the work scales
  // with the chain set. This line turns that into a positive assertion to
  // check against the expected deployments (Codex #1924 r13).
  const chains = getChainConfigs(resolved);
  // eslint-disable-next-line no-console
  console.log(
    `[keeper] chains resolved: ${chains.length} — ${
      chains.map((c) => `${c.name}(${c.id})`).join(', ') || 'NONE'
    }`,
  );

  // ONE loop over the declared table (#1896), rather than ten
  // hand-written blocks. Each pass still gets its own deferral and its own
  // `.catch` (inside `timedPass`), so a transient failure in one cannot
  // wedge the next — that property is structural instead of being repeated
  // ten times and relied upon to stay repeated.
  for (const pass of KEEPER_PASSES) {
    const skip = cadenceSkipReason(pass, scheduledTimeMs);
    if (skip !== null) {
      // Legible, not silent — the contract `passIsArmed` established
      // for arming (#1475), extended to cadence. A pass that is idle
      // because it is not due and a pass that is idle because it is
      // wedged must never look the same in a log.
      // eslint-disable-next-line no-console
      console.log(`[keeper] ${pass.name} skipped: ${skip}`);
      continue;
    }
    defer(timedPass(pass.name, () => pass.run(resolved, { scheduledTimeMs })));
  }
}
