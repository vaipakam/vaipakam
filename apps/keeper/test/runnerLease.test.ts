/**
 * The one-runner lease (#2503), against the real migration DDL on SQLite:
 * the claim is one upsert whose WHERE decides who may hold the row, so the
 * behaviour IS the SQL and is tested on a real engine.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { WorkerEnv } from '../src/env';
import { claimRunnerLease, LEASE_TTL_MS } from '../src/runnerLease';
import { runKeeperTick } from '../src/tick';
import { createTickRunner } from '../host/scheduler';
import { createSqliteD1 } from './helpers/sqliteD1';

const DDL = readFileSync(
  new URL('../../indexer/migrations/0059_keeper_runner_lease.sql', import.meta.url),
  'utf8',
);

function fresh() {
  const { d1, db } = createSqliteD1([DDL]);
  return { db: d1 as D1Database, raw: db };
}

const T0 = 1_760_000_000_000;

describe('claimRunnerLease', () => {
  it('lets the first runner acquire, and renews for the same runner', async () => {
    const { db, raw } = fresh();
    expect(await claimRunnerLease(db, 'host:a', T0)).toEqual({ held: true, acquired: true });
    expect(await claimRunnerLease(db, 'host:a', T0 + 60_000)).toEqual({ held: true, acquired: false });
    expect(raw.prepare('SELECT acquired_at, expires_at FROM keeper_runner_lease').get()).toEqual({
      acquired_at: T0,
      expires_at: T0 + 60_000 + LEASE_TTL_MS,
    });
  });

  it('refuses another runner while the lease is live, and names the holder', async () => {
    const { db, raw } = fresh();
    await claimRunnerLease(db, 'host:a', T0);
    const claim = await claimRunnerLease(db, 'cloudflare-worker', T0 + LEASE_TTL_MS - 1);
    expect(claim.held).toBe(false);
    expect(claim.held === false && claim.reason).toContain('"host:a" holds the one-runner lease until');
    expect(raw.prepare('SELECT holder FROM keeper_runner_lease').get()).toEqual({ holder: 'host:a' });
  });

  it('hands over once the holder stops renewing', async () => {
    const { db, raw } = fresh();
    await claimRunnerLease(db, 'host:a', T0);
    const later = T0 + LEASE_TTL_MS;
    expect(await claimRunnerLease(db, 'host:b', later)).toEqual({ held: true, acquired: true });
    expect(raw.prepare('SELECT holder, acquired_at FROM keeper_runner_lease').get()).toEqual({
      holder: 'host:b',
      acquired_at: later,
    });
    // The old holder, coming back, is now the one refused.
    expect((await claimRunnerLease(db, 'host:a', later + 1)).held).toBe(false);
  });

  it('declines with no runner id rather than guessing one', async () => {
    const { db, raw } = fresh();
    for (const id of [undefined, '', '  ']) {
      const claim = await claimRunnerLease(db, id, T0);
      expect(claim.held === false && claim.reason).toContain('KEEPER_RUNNER_ID is not set');
    }
    expect(raw.prepare('SELECT COUNT(*) AS n FROM keeper_runner_lease').get()).toEqual({ n: 0 });
  });

  it('declines, without throwing, when the table is missing', async () => {
    const { d1 } = createSqliteD1([]);
    const claim = await claimRunnerLease(d1 as D1Database, 'host:a', T0);
    expect(claim.held).toBe(false);
    expect(claim.held === false && claim.reason).toContain('could not claim the one-runner lease');
  });
});

describe('the tick and the lease', () => {
  it('launches no pass while another runner holds the lease', async () => {
    const { db } = fresh();
    await claimRunnerLease(db, 'host:a', Date.now());
    const launched: string[] = [];
    const env = { DB: db, KEEPER_RUNNER_ID: 'cloudflare-worker' } as unknown as WorkerEnv;
    await runKeeperTick(env, Date.now(), (name) => launched.push(name));
    expect(launched).toEqual([]);
  });

  it('renews on a minute skipped for a still-running tick', async () => {
    let release!: () => void;
    const skips: number[] = [];
    const runner = createTickRunner({
      runTick: () => new Promise<void>((r) => (release = r)),
      log: () => {},
      onSkip: async (t) => {
        skips.push(t);
      },
    });
    expect(runner.fire(T0)).toBe(true);
    expect(runner.fire(T0 + 60_000)).toBe(false);
    expect(skips).toEqual([T0 + 60_000]);
    release();
    await runner.idle();
  });
});
