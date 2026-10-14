/**
 * One machine-hosted tick: build the env, confirm the schema, run the tick.
 *
 * SCHEMA. On Cloudflare the keeper's deploy refuses to publish until the
 * shared database records every migration the build carries (#2409). A
 * machine has no deploy step: pulling new code and restarting IS the
 * release. So each tick first asks the database the same question, with the
 * indexer's own gate and migration list (the list the keeper's deploy
 * already verifies against), and declines by name while any migration is
 * missing. It resumes by itself once the indexer has applied them. The gate
 * caches only `current`, so the steady-state cost is one read per process.
 */

import { createSchemaGate, type SchemaCheck } from '../../indexer/src/schemaGate';
import type { WorkerEnv } from '../src/env';
import { claimRunnerLease } from '../src/runnerLease';
import { runKeeperTick } from '../src/tick';
import { buildHostEnv } from './hostEnv';

type Launch = (passName: string, run: Promise<void>) => void;

export interface HostTickDeps {
  /** The process environment, read on every tick. */
  vars: () => Record<string, string | undefined>;
  log: (line: string) => void;
  /** Injected for tests; defaults to a gate over the indexer's list. */
  gate?: { check(db: D1Database): Promise<SchemaCheck> };
  /** Injected for tests; defaults to the shared tick. */
  runTick?: (env: WorkerEnv, scheduledTimeMs: number, launch: Launch) => Promise<void>;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchFn?: typeof fetch;
}

export function schemaDeclineLine(check: Exclude<SchemaCheck, { state: 'current' }>): string {
  if (check.state === 'unknown') {
    return '[keeper-host] tick declined: could not read d1_migrations to confirm the schema; retrying next tick';
  }
  return `[keeper-host] tick declined: D1 migration(s) ${check.missing.join(', ')} not applied; the indexer's deploy applies them, and ticks resume once it has`;
}

export function createHostTick(deps: HostTickDeps) {
  const gate = deps.gate ?? createSchemaGate();
  const runTick = deps.runTick ?? runKeeperTick;
  return async (scheduledTimeMs: number, launch: Launch): Promise<void> => {
    // Rebuilt per tick, as a Worker resolves its bindings per invocation.
    const { env } = buildHostEnv(deps.vars(), deps.fetchFn);
    // With no database the shared tick declines as a maintenance build.
    if (env.DB !== undefined) {
      const schema = await gate.check(env.DB);
      if (schema.state !== 'current') {
        deps.log(schemaDeclineLine(schema));
        return;
      }
    }
    await runTick(env, scheduledTimeMs, launch);
  };
}

/**
 * Renews the one-runner lease on a minute the scheduler skipped because the
 * previous tick is still running (#2503). Renewal only: a claim by a runner
 * that does not already hold the lease is the same statement, so this can
 * never take the lease from another runner, and a decline is logged rather
 * than acted on (the next tick that starts declines by itself).
 */
export function createHostLeaseRenewal(deps: Pick<HostTickDeps, 'vars' | 'log' | 'fetchFn'> & { nowMs?: () => number }) {
  const now = deps.nowMs ?? (() => Date.now());
  return async (): Promise<void> => {
    const { env } = buildHostEnv(deps.vars(), deps.fetchFn);
    if (env.DB === undefined) return;
    const lease = await claimRunnerLease(env.DB, env.KEEPER_RUNNER_ID, now());
    if (!lease.held) deps.log(`[keeper-host] lease not renewed during a long tick: ${lease.reason}`);
  };
}
