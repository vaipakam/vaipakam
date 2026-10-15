/**
 * apps/keeper — one scheduled tick, independent of what is hosting it.
 *
 * The Worker's `scheduled()` handler (`src/index.ts`) and the always-on
 * machine runtime (`host/main.ts`) both run exactly this, so the two hosts
 * cannot drift in what a tick does: the D1 check, the secret resolution, the
 * chain-set line and the per-pass cadence and launch.
 *
 * What differs is only how a launched pass is kept alive, so the host passes
 * that in as `launch`: the Worker hands each one to `ctx.waitUntil`, the
 * machine runtime tracks and awaits them.
 */

import { getChainConfigs, resolveEnv, WORKER_NAME, type WorkerEnv } from './env';
import {
  hasD1Binding,
  maintenanceSkipNotice,
} from '@vaipakam/lib/d1Maintenance';
import { KEEPER_PASSES, cadenceSkipReason } from './passSchedule';
import { claimRunnerLease } from './runnerLease';
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
async function timedPass(name: string, run: () => Promise<void>): Promise<void> {
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
    console.error(
      `[keeper] ${name} pass failed after ${Date.now() - startedAt}ms:`,
      err,
    );
  }
}

/**
 * Run one tick. `scheduledTimeMs` is the tick's SCHEDULED epoch, not the
 * moment it ran, so a late delivery cannot make a `% n` cadence skip its
 * minute. `launch` receives every pass that is due, already wrapped so it
 * never rejects; this function returns once they are all launched, not
 * once they finish.
 */
export async function runKeeperTick(
  env: WorkerEnv,
  scheduledTimeMs: number | undefined,
  launch: (passName: string, run: Promise<void>) => void,
): Promise<void> {
  // #2239 — decline the whole tick when this build has no D1 binding.
  //
  // Every pass below reads or writes the database, so without this the tick
  // would launch a dozen `waitUntil` continuations that each discover the
  // refusal separately and each log a failure. One line, at the one place
  // that can see the whole tick, is what an operator can actually read —
  // and declining before `resolveEnv` also means a maintenance build stops
  // fetching secrets it has no use for.
  if (env.DB === undefined || !hasD1Binding(env.DB)) {
    // eslint-disable-next-line no-console
    console.warn(maintenanceSkipNotice(WORKER_NAME, 'this tick'));
    return;
  }

  // #2503 — one runner at a time. Claimed before anything else reads a
  // secret or the chain, so a runner that is not the holder does no work and
  // says whose lease it is waiting on. A failure to claim declines too.
  const lease = await claimRunnerLease(env.DB, env.KEEPER_RUNNER_ID);
  if (!lease.held) {
    // eslint-disable-next-line no-console
    console.warn(`[keeper] tick declined: ${lease.reason}`);
    return;
  }
  if (lease.acquired) {
    // eslint-disable-next-line no-console
    console.log(`[keeper] runner "${env.KEEPER_RUNNER_ID}" acquired the one-runner lease`);
  }

  // T-078 — resolve the Secrets Store bindings once, here at the
  // entry point; every scheduled pass gets the plain resolved env.
  const resolved = await resolveEnv(env);

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
  // hand-written blocks. Each pass still gets its own `launch` and
  // its own `.catch`, so a transient failure in one cannot wedge the
  // next — that property is now structural instead of being repeated
  // ten times and relied upon to stay repeated.
  for (const pass of KEEPER_PASSES) {
    const skip = cadenceSkipReason(pass, scheduledTimeMs);
    if (skip !== null) {
      // Legible, not silent — the contract `passIsArmed` established
      // for arming (#1475), extended to cadence. A pass that is idle
      // because it is not due and a pass that is idle because it is
      // wedged must never look the same in `wrangler tail`.
      // eslint-disable-next-line no-console
      console.log(`[keeper] ${pass.name} skipped: ${skip}`);
      continue;
    }
    launch(pass.name, timedPass(pass.name, () => pass.run(resolved, { scheduledTimeMs })));
  }
}
