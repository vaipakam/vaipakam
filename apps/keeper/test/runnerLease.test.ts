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
import { buildHostEnv } from '../host/hostEnv';
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

/** Ages the lease row by `ms`, as if that much time passed on the database's clock. */
function age(raw: ReturnType<typeof fresh>['raw'], ms: number) {
  raw.prepare('UPDATE keeper_runner_lease SET acquired_at = acquired_at - ?1, renewed_at = renewed_at - ?1, expires_at = expires_at - ?1').run(ms);
}

describe('claimRunnerLease', () => {
  it('lets the first runner acquire, and renews for the same runner', async () => {
    const { db, raw } = fresh();
    const before = Date.now();
    expect(await claimRunnerLease(db, 'host:a')).toEqual({ held: true, acquired: true });
    const first = raw.prepare('SELECT acquired_at, renewed_at, expires_at FROM keeper_runner_lease').get() as Record<string, number>;
    // The time is the database's own clock (here the same machine's, so it
    // brackets this test's), and the expiry is that time plus the TTL.
    expect(first.acquired_at).toBeGreaterThanOrEqual(before - 1000);
    expect(first.acquired_at).toBeLessThanOrEqual(Date.now() + 1000);
    expect(first.expires_at).toBe(first.renewed_at + LEASE_TTL_MS);
    age(raw, 60_000);
    expect(await claimRunnerLease(db, 'host:a')).toEqual({ held: true, acquired: false });
    const second = raw.prepare('SELECT acquired_at, renewed_at, expires_at FROM keeper_runner_lease').get() as Record<string, number>;
    expect(second.acquired_at).toBe(first.acquired_at - 60_000);
    expect(second.expires_at).toBe(second.renewed_at + LEASE_TTL_MS);
  });

  it('refuses another runner while the lease is live, and names the holder', async () => {
    const { db, raw } = fresh();
    await claimRunnerLease(db, 'host:a');
    age(raw, LEASE_TTL_MS - 60_000);
    const claim = await claimRunnerLease(db, 'cloudflare-worker');
    expect(claim.held).toBe(false);
    expect(claim.held === false && claim.reason).toContain('"host:a" holds the one-runner lease until');
    expect(raw.prepare('SELECT holder FROM keeper_runner_lease').get()).toEqual({ holder: 'host:a' });
  });

  it('hands over once the holder stops renewing', async () => {
    const { db, raw } = fresh();
    await claimRunnerLease(db, 'host:a');
    age(raw, LEASE_TTL_MS);
    expect(await claimRunnerLease(db, 'host:b')).toEqual({ held: true, acquired: true });
    expect(raw.prepare('SELECT holder FROM keeper_runner_lease').get()).toEqual({ holder: 'host:b' });
    // The old holder, coming back, is now the one refused.
    expect((await claimRunnerLease(db, 'host:a')).held).toBe(false);
  });

  it('declines with no runner id rather than guessing one', async () => {
    const { db, raw } = fresh();
    for (const id of [undefined, '', '  ']) {
      const claim = await claimRunnerLease(db, id);
      expect(claim.held === false && claim.reason).toContain('KEEPER_RUNNER_ID is not set');
    }
    expect(raw.prepare('SELECT COUNT(*) AS n FROM keeper_runner_lease').get()).toEqual({ n: 0 });
  });

  it('declines, without throwing, when the table is missing', async () => {
    const { d1 } = createSqliteD1([]);
    const claim = await claimRunnerLease(d1 as D1Database, 'host:a');
    expect(claim.held).toBe(false);
    expect(claim.held === false && claim.reason).toContain('could not claim the one-runner lease');
  });
});

describe('the tick and the lease', () => {
  it('launches no pass while another runner holds the lease', async () => {
    const { db } = fresh();
    await claimRunnerLease(db, 'host:a');
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

describe('a machine\'s runner id', () => {
  it('defaults to host:<host name>, so an env file without one still claims the lease', () => {
    expect(buildHostEnv({}, undefined, () => 'keeper-vm').env.KEEPER_RUNNER_ID).toBe('host:keeper-vm');
    expect(buildHostEnv({ KEEPER_RUNNER_ID: '' }, undefined, () => 'keeper-vm').env.KEEPER_RUNNER_ID).toBe('host:keeper-vm');
  });

  it('keeps one the env file sets', () => {
    expect(buildHostEnv({ KEEPER_RUNNER_ID: 'host:custom' }, undefined, () => 'keeper-vm').env.KEEPER_RUNNER_ID).toBe('host:custom');
  });
});
